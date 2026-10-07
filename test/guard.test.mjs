// 离线单元测试：不触碰任何 DSH 运行时，只验证选择逻辑、恢复终止性与安全边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, countRetainedImages, matchImageLimit, selectOldestImages } from '../src/index.js';

const REAL_FAILURE = '400: {"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] a request may include at most 20 images"}';

/** 造一个会话替身：append('image/offload') 像真实投影那样就地标记 offloaded。 */
function makeSession(entries) {
	const appended = [];
	return {
		surface: { nodes: entries.map((entry) => entry.seq) },
		eventAt(seq) {
			return entries.find((entry) => entry.seq === seq);
		},
		deriveEventMessage(event) {
			return { content: event.content };
		},
		append(type, data) {
			for (const target of data.targets) {
				const entry = entries.find((candidate) => candidate.seq === target.seq);
				let imageIndex = 0;
				for (const block of entry.content) {
					if (block.type !== 'image') continue;
					if (target.imageIndexes.includes(imageIndex)) block.offloaded = true;
					imageIndex += 1;
				}
			}
			appended.push({ type, data });
			return { seq: 9000 + appended.length };
		},
		appended,
		entries,
	};
}

/** 造 n 条 tool/result 事件，每条挂 imagesPerEvent 张图。 */
function makeEntries(eventCount, imagesPerEvent) {
	const entries = [];
	for (let index = 0; index < eventCount; index += 1) {
		const content = [{ type: 'text', text: `result ${index}` }];
		for (let image = 0; image < imagesPerEvent; image += 1) content.push({ type: 'image', attachment: { attachmentId: `a${index}-${image}` } });
		entries.push({ seq: index + 1, type: 'tool/result', message: { content }, content });
	}
	return entries;
}

function makeCtx() {
	let handler;
	const logs = [];
	return {
		on(name, fn) {
			if (name === 'agent/request-error') handler = fn;
		},
		logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
		invoke(payload, next = () => Promise.resolve(undefined)) {
			return handler(payload, next);
		},
		logs,
	};
}

test('matchImageLimit 认得上游真实报错并取出上限', () => {
	assert.deepEqual(matchImageLimit(REAL_FAILURE), { limit: 20 });
	assert.deepEqual(matchImageLimit('Upstream request failed: too many images'), { limit: undefined });
	assert.deepEqual(matchImageLimit('your request may include a maximum of 8 images'), { limit: 8 });
});

test('matchImageLimit 不把无关失败当成图片超限', () => {
	assert.equal(matchImageLimit('400: {"error":{"message":"context length exceeded"}}'), null);
	assert.equal(matchImageLimit('image generation is disabled'), null);
	assert.equal(matchImageLimit(undefined), null);
	assert.equal(matchImageLimit(''), null);
});

test('selectOldestImages 只选未省略的出现位置，索引严格递增', () => {
	const entries = makeEntries(3, 2);
	const session = makeSession(entries);
	const targets = selectOldestImages(session, session.surface.nodes, 3);
	assert.deepEqual(targets, [
		{ seq: 1, imageIndexes: [0, 1] },
		{ seq: 2, imageIndexes: [0] },
	]);
});

test('36 张图 + 上限 20 → 卸载 18 张并重试本步', async () => {
	const entries = makeEntries(18, 2); // 36 张
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	assert.equal(countRetainedImages(session, session.surface.nodes), 36);
	const action = await ctx.invoke({ agent: { session }, failure: { code: 'INVALID_REQUEST', message: REAL_FAILURE } });

	assert.deepEqual(action, { kind: 'retry' });
	assert.equal(session.appended.length, 1);
	assert.equal(session.appended[0].type, 'image/offload');
	assert.equal(countRetainedImages(session, session.surface.nodes), 18);
	assert.equal(session.appended[0].data.targets.reduce((sum, target) => sum + target.imageIndexes.length, 0), 18);
});

test('持续 400 时收敛：反复重试直到全部省略，然后交回下游', async () => {
	const entries = makeEntries(18, 2); // 36 张
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;
		return Promise.resolve(undefined);
	};

	let retries = 0;
	for (;;) {
		const action = await ctx.invoke({ agent: { session }, failure: { code: 'INVALID_REQUEST', message: REAL_FAILURE } }, next);
		if (action?.kind !== 'retry') break;
		retries += 1;
		assert.ok(retries <= 40, '重试次数不应失控');
	}

	assert.equal(nextCalls, 1, '无法继续省略时必须且只交回下游一次');
	assert.equal(countRetainedImages(session, session.surface.nodes), 0);
});

test('错误文本与图片无关时直接交回下游，不做任何省略', async () => {
	const entries = makeEntries(18, 2);
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	let nextCalls = 0;
	await ctx.invoke({ agent: { session }, failure: { code: 'RATE_LIMIT', message: '429 too many requests' } }, () => {
		nextCalls += 1;
		return Promise.resolve(undefined);
	});
	assert.equal(nextCalls, 1);
	assert.equal(session.appended.length, 0);
	assert.equal(countRetainedImages(session, session.surface.nodes), 36);
});

test('历史里没有图片时交回下游', async () => {
	const entries = makeEntries(3, 0);
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	let nextCalls = 0;
	await ctx.invoke({ agent: { session }, failure: { message: REAL_FAILURE } }, () => {
		nextCalls += 1;
		return Promise.resolve(undefined);
	});
	assert.equal(nextCalls, 1);
	assert.equal(session.appended.length, 0);
});

test('统计值已在上限内仍被拒时，按一半推进，保证恢复能收敛', async () => {
	const entries = makeEntries(4, 2); // 8 张 < 18 目标
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	const action = await ctx.invoke({ agent: { session }, failure: { message: REAL_FAILURE } });
	assert.deepEqual(action, { kind: 'retry' });
	assert.equal(countRetainedImages(session, session.surface.nodes), 4);
});

test('统计值已在上限内时的收敛轮数受控', async () => {
	const entries = makeEntries(18, 2); // 36 张
	const session = makeSession(entries);
	const ctx = makeCtx();
	apply(ctx);

	// 每次都被拒（模拟上游计数口径与本地统计不同）时的轮数上界
	let rounds = 0;
	for (;;) {
		rounds += 1;
		const action = await ctx.invoke({ agent: { session }, failure: { message: REAL_FAILURE } }, () => Promise.resolve(undefined));
		if (action?.kind !== 'retry') break;
		assert.ok(rounds <= 12, `收敛轮数应受控，实际 ${rounds}`);
	}
	assert.equal(countRetainedImages(session, session.surface.nodes), 0);
});

test('投影未注册（append 抛错）时保持失败终态', async () => {
	const entries = makeEntries(18, 2);
	const session = makeSession(entries);
	session.append = () => {
		throw new Error('image/offload: projection is not registered');
	};
	const ctx = makeCtx();
	apply(ctx);

	let nextCalls = 0;
	const action = await ctx.invoke({ agent: { session }, failure: { message: REAL_FAILURE } }, () => {
		nextCalls += 1;
		return Promise.resolve(undefined);
	});
	assert.equal(action, undefined);
	assert.equal(nextCalls, 1);
});

test('selectOldestImages 跳过 user/message 之外的无关事件', () => {
	const entries = [
		{ seq: 1, type: 'assistant/message', content: [{ type: 'image' }] },
		{ seq: 2, type: 'user/message', content: [{ type: 'image' }] },
		{ seq: 3, type: 'system/message', content: [{ type: 'image' }] },
	];
	const session = makeSession(entries);
	assert.deepEqual(selectOldestImages(session, session.surface.nodes, 5), [{ seq: 2, imageIndexes: [0] }]);
});
