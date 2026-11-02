import test from 'ava';
import pRetry from '../index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test.serial('retry delays exceeding the timer limit are split into chunks', async t => {
	const maximumTimeout = (2 ** 31) - 1;
	const captured = [];
	const originalSetTimeout = setTimeout;
	let unrefCalls = 0;
	globalThis.setTimeout = (function_, milliseconds) => {
		captured.push(milliseconds);
		const timeout = originalSetTimeout(function_, 0);
		timeout.unref = () => {
			unrefCalls++;
		};

		return timeout;
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	const result = await pRetry(attemptNumber => {
		if (attemptNumber === 1) {
			throw fixtureError;
		}

		return fixture;
	}, {retries: 1, minTimeout: (maximumTimeout * 2) + 3, unref: true});

	t.is(result, fixture);
	t.deepEqual(captured, [maximumTimeout, maximumTimeout, 3]);
	t.is(unrefCalls, 3);
});

test.serial('long retry delays remain abortable after the first timer chunk', async t => {
	const maximumTimeout = (2 ** 31) - 1;
	const controller = new AbortController();
	const captured = [];
	const originalSetTimeout = setTimeout;
	let attempts = 0;
	globalThis.setTimeout = (function_, milliseconds) => {
		captured.push(milliseconds);
		return originalSetTimeout(() => {
			if (captured.length === 2) {
				controller.abort(fixtureError);
				return;
			}

			function_();
		}, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(() => {
		attempts++;
		throw new Error('retry');
	}, {
		retries: 1,
		minTimeout: maximumTimeout + 100,
		signal: controller.signal,
	}), {is: fixtureError});

	t.is(attempts, 1);
	t.deepEqual(captured, [maximumTimeout, 100]);
});

test('retry delays above the timer limit do not retry before aborting', async t => {
	const controller = new AbortController();
	let attempts = 0;
	const timeout = setTimeout(() => controller.abort(fixtureError), 50);
	t.teardown(() => clearTimeout(timeout));

	await t.throwsAsync(pRetry(() => {
		attempts++;
		throw new Error('retry');
	}, {
		retries: 1,
		minTimeout: 2 ** 31,
		signal: controller.signal,
	}), {is: fixtureError});

	t.is(attempts, 1);
});

test.serial('late timer chunks count toward the remaining retry delay', async t => {
	const maximumTimeout = (2 ** 31) - 1;
	const originalSetTimeout = setTimeout;
	const originalPerformanceNow = performance.now;

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
		performance.now = originalPerformanceNow;
	});

	for (const extraDelay of [200, 2000]) {
		const captured = [];
		let now = 0;
		performance.now = () => now;
		globalThis.setTimeout = (function_, milliseconds) => {
			captured.push(milliseconds);
			return originalSetTimeout(() => {
				now += milliseconds + (captured.length === 1 ? extraDelay : 0);
				function_();
			}, 0);
		};

		const result = await pRetry(attemptNumber => {
			if (attemptNumber === 1) {
				throw fixtureError;
			}

			return fixture;
		}, {
			retries: 1,
			minTimeout: maximumTimeout + 1000,
			maxRetryTime: maximumTimeout + 1000,
		});

		t.is(result, fixture);
		t.deepEqual(captured, extraDelay < 1000 ? [maximumTimeout, 800] : [maximumTimeout]);
	}
});

