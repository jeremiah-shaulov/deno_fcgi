export const ASSERTIONS_ENABLED = true;

export function debug_assert(expr: unknown): asserts expr
{	if (ASSERTIONS_ENABLED && !expr)
	{	let stack_frame = new Error().stack?.split('\n')?.[2]?.match(/ \(.*/)?.[0] || '';
		throw new Error('Assertion failed'+stack_frame);
	}
}
