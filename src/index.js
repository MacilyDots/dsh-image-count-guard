/**
 * Image-count guard for image-capable DSH routes.
 *
 * Why this exists: `dsh-llm-pi-ai` bounds request images by base64 payload bytes
 * only (`maxRequestImageBytes`, 20 MiB by default) and has no per-count bound,
 * while some gateways (OpenCode Go verified 2026-09-29) hard-reject a request
 * carrying more than 20 images. The gateway answers with a plain
 * `INVALID_REQUEST` failure, not `IMAGE_OFFLOAD_REQUIRED`, so the shipped
 * `dsh-compaction-image-offload` executor never takes over: the step fails, and
 * every later step of that session fails the same way.
 *
 * What this does: on an `agent/request-error` waterfall entry whose failure text
 * names an image-count limit, it records one `image/offload` decision selecting
 * the oldest retained image occurrences — the same durable projection the
 * shipped executor uses, so placeholders, replay and token metering all follow
 * unchanged — and then retries the step. Each retry offloads at least one more
 * occurrence, so recovery terminates: either the request fits, or nothing
 * remains to offload and the original failure stays terminal.
 *
 * @module dsh-image-count-guard
 */

/** Plugin name as mounted by the profile patch. */
export const name = 'image-count-guard';

/** Services this plugin reads. */
export const inject = ['agents'];

/** Image-count limit assumed when the gateway does not name one. */
const DEFAULT_IMAGE_LIMIT = 20;

/** Occurrences kept below the limit, so one new image does not fail the next request. */
const DEFAULT_SAFETY_MARGIN = 2;

/** Upper bound on occurrences offloaded by one retry. */
const DEFAULT_MAX_OFFLOAD_PER_RETRY = 80;

/**
 * Failure-text shapes that name an image-count limit. Every pattern requires the
 * word "image" so an unrelated provider message can never trigger an offload.
 */
const LIMIT_PATTERNS = [
	/at most\s+(\d+)\s+images?/i,
	/(?:maximum|max) of\s+(\d+)\s+images?/i,
	/no more than\s+(\d+)\s+images?/i,
	/up to\s+(\d+)\s+images?/i,
	/too many images?/i,
];

/**
 * Recognize an image-count rejection and read its limit.
 * @param message - provider failure text, if any.
 * @returns `null` when the text is not an image-count rejection; otherwise the
 * declared limit, or `undefined` when the text names no number.
 */
export function matchImageLimit(message) {
	if (typeof message !== 'string' || message.length === 0) return null;
	if (!/image/i.test(message)) return null;
	for (const pattern of LIMIT_PATTERNS) {
		const match = pattern.exec(message);
		if (match === null) continue;
		const limit = match[1] === undefined ? undefined : Number(match[1]);
		return { limit: Number.isSafeInteger(limit) && limit > 0 ? limit : undefined };
	}
	return null;
}

/** Whether one message event can carry input images selected for offload. */
function isImageBearingEvent(event) {
	return event?.type === 'user/message' || event?.type === 'tool/result';
}

/**
 * Apply the current offload projection for one surface node.
 * @returns the projected content blocks, or `null` when the node carries none.
 */
function projectedContent(session, seq) {
	const event = session.eventAt(seq);
	if (!isImageBearingEvent(event)) return null;
	const message = session.deriveEventMessage(event);
	return Array.isArray(message?.content) ? message.content : null;
}

/**
 * Count image occurrences the next request would still send.
 * @param session - session owning the surface.
 * @param nodes - current surface nodes in model-request order.
 * @returns the number of retained (not yet offloaded) occurrences.
 */
export function countRetainedImages(session, nodes) {
	let total = 0;
	for (const seq of nodes) {
		const content = projectedContent(session, seq);
		if (content === null) continue;
		for (const block of content) {
			if (block?.type === 'image' && block.offloaded !== true) total += 1;
		}
	}
	return total;
}

/**
 * Select the oldest retained occurrences, in model-request order.
 * Image indexes count every occurrence in a message, including previously
 * offloaded ones, matching the durable `image/offload` projection contract.
 * @param session - session owning the surface.
 * @param nodes - current surface nodes in model-request order.
 * @param count - occurrences to select; positive.
 * @returns one `{ seq, imageIndexes }` target per contributing message.
 */
export function selectOldestImages(session, nodes, count) {
	const targets = [];
	let remaining = count;
	for (const seq of nodes) {
		if (remaining <= 0) break;
		const content = projectedContent(session, seq);
		if (content === null) continue;
		const imageIndexes = [];
		let imageIndex = 0;
		for (const block of content) {
			if (remaining <= 0) break;
			if (block?.type !== 'image') continue;
			if (block.offloaded !== true) {
				imageIndexes.push(imageIndex);
				remaining -= 1;
			}
			imageIndex += 1;
		}
		if (imageIndexes.length > 0) targets.push({ seq, imageIndexes });
	}
	return targets;
}

/** Read one positive-integer option, falling back to its default. */
function positiveInteger(value, fallback, { allowZero = false } = {}) {
	if (!Number.isSafeInteger(value)) return fallback;
	if (value > 0) return value;
	return allowZero && value === 0 ? 0 : fallback;
}

/**
 * Mount the recovery listener.
 * @param ctx - the plugin context.
 * @param config - optional `{ defaultImageLimit, safetyMargin, maxOffloadPerRetry }`.
 */
export function apply(ctx, config = {}) {
	const defaultImageLimit = positiveInteger(config?.defaultImageLimit, DEFAULT_IMAGE_LIMIT);
	const safetyMargin = positiveInteger(config?.safetyMargin, DEFAULT_SAFETY_MARGIN, { allowZero: true });
	const maxOffloadPerRetry = positiveInteger(config?.maxOffloadPerRetry, DEFAULT_MAX_OFFLOAD_PER_RETRY);

	ctx.on('agent/request-error', ({ agent, failure }, next) => {
		const matched = matchImageLimit(failure?.message);
		if (matched === null) return next();

		const session = agent?.session;
		const nodes = session?.surface?.nodes;
		if (!Array.isArray(nodes) || nodes.length === 0) return next();

		// The gateway's own number wins; the configured default only fills a gap.
		const limit = matched.limit ?? defaultImageLimit;
		const target = Math.max(1, limit - safetyMargin);

		let total;
		try {
			total = countRetainedImages(session, nodes);
		} catch (error) {
			ctx.logger?.warn?.(`image-count-guard: 统计请求图片失败，交回下游：${error?.message ?? error}`);
			return next();
		}
		if (total === 0) return next();

		// Normal path: cut down to the target. Fallback path: our count already fits
		// the named limit yet the gateway still refused, so its counting differs
		// from occurrence number; halving converges in a few retries instead of one
		// occurrence at a time. Either way every retry shrinks the retained set, so
		// recovery terminates.
		const need = total > target
			? Math.min(maxOffloadPerRetry, total - target)
			: Math.max(1, Math.min(maxOffloadPerRetry, Math.ceil(total / 2)));

		let targets;
		try {
			targets = selectOldestImages(session, nodes, need);
		} catch (error) {
			ctx.logger?.warn?.(`image-count-guard: 选择待省略图片失败，交回下游：${error?.message ?? error}`);
			return next();
		}
		if (targets.length === 0) return next();

		try {
			session.append('image/offload', { targets });
		} catch (error) {
			// Without the shipped projection registered, recording a decision is
			// refused; leaving the failure terminal is the only safe option.
			ctx.logger?.warn?.(`image-count-guard: 写入 image/offload 失败，交回下游：${error?.message ?? error}`);
			return next();
		}

		const offloaded = targets.reduce((sum, target2) => sum + target2.imageIndexes.length, 0);
		ctx.logger?.info?.(`image-count-guard: 上游按图片张数拒绝（上限 ${limit} 张），已将最旧的 ${offloaded} 张图片换成占位文本并重试本步（保留 ${total - offloaded} 张）`);
		return Promise.resolve({ kind: 'retry' });
	});
}
