import {ASSERTIONS_ENABLED, debug_assert} from '../debug_assert.ts';
import {assert} from "https://deno.land/std@0.135.0/testing/asserts.ts";

Deno.test
(	'debug_assert',
	() =>
	{	debug_assert(true);
		let error;
		try
		{	debug_assert(false);
		}
		catch (e)
		{	error = e;
		}
		assert(!ASSERTIONS_ENABLED || error);
	}
);
