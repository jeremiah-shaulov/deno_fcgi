const ASSERTIONS_ENABLED = true;

export function assert(expr: unknown): asserts expr
{	if (ASSERTIONS_ENABLED && !expr)
	{	throw new Error('Assertion failed');
	}
}
