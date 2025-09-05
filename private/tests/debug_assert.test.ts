import {ASSERTIONS_ENABLED, debug_assert} from '../debug_assert.ts';
import {assert} from 'jsr:@std/assert@1.0.14/assert';

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
