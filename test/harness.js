// Minimal describe/it/expect harness for gjs (no external dependencies).
const suites = [];
let current = null;

export function describe(name, fn) {
    const parent = current;
    const suite = {name: parent ? `${parent.name} > ${name}` : name, tests: [], before: [...(parent?.before ?? [])], after: [...(parent?.after ?? [])]};
    suites.push(suite);
    current = suite;
    fn();
    current = parent;
}

export function it(name, fn) {
    current.tests.push({name, fn});
}

export function beforeEach(fn) {
    current.before.push(fn);
}

export function afterEach(fn) {
    current.after.push(fn);
}

class AssertionError extends Error {}

function fmt(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (a instanceof Date && b instanceof Date)
        return a.getTime() === b.getTime();
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b)
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
}

export function expect(actual) {
    const fail = msg => {
        throw new AssertionError(msg);
    };
    const m = {
        toBe: e => Object.is(actual, e) || fail(`expected ${fmt(actual)} to be ${fmt(e)}`),
        toEqual: e => deepEqual(actual, e) || fail(`expected ${fmt(actual)} to equal ${fmt(e)}`),
        toBeTruthy: () => actual || fail(`expected ${fmt(actual)} to be truthy`),
        toBeFalsy: () => !actual || fail(`expected ${fmt(actual)} to be falsy`),
        toBeNull: () => actual === null || fail(`expected ${fmt(actual)} to be null`),
        toContain: e => actual.includes(e) || fail(`expected ${fmt(actual)} to contain ${fmt(e)}`),
        toBeCloseTo: (e, eps = 1e-9) => Math.abs(actual - e) <= eps || fail(`expected ${actual} ≈ ${e}`),
        toThrow: type => {
            try {
                actual();
            } catch (e) {
                if (type && !(e instanceof type))
                    fail(`expected ${type.name}, got ${e?.constructor?.name}: ${e?.message}`);
                return true;
            }
            return fail('expected function to throw');
        },
        toReject: async type => {
            try {
                await actual;
            } catch (e) {
                if (type && !(e instanceof type))
                    fail(`expected rejection with ${type.name}, got ${e?.constructor?.name}: ${e?.message}`);
                return e;
            }
            return fail('expected promise to reject');
        },
    };
    return m;
}

export async function run() {
    let passed = 0, failed = 0;
    for (const suite of suites) {
        for (const t of suite.tests) {
            try {
                for (const b of suite.before)
                    await b();
                try {
                    await t.fn();
                } finally {
                    for (const a of suite.after)
                        await a();
                }
                passed++;
            } catch (e) {
                failed++;
                print(`✗ ${suite.name} > ${t.name}\n    ${e?.message ?? e}`);
                if (!(e instanceof AssertionError) && e?.stack)
                    print(e.stack.split('\n').map(l => `      ${l}`).join('\n'));
            }
        }
    }
    print(`\n${passed} passed, ${failed} failed`);
    return failed;
}
