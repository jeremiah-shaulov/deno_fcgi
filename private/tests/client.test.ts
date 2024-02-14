import {Client, ResponseWithCookies} from '../client.ts';
import {RdStream} from '../deps.ts';
import {MockConn, get_random_string} from './mock/mod.ts';
import {assertEquals} from 'https://deno.land/std@0.135.0/testing/asserts.ts';

// deno-lint-ignore require-await
async function get_mock_response(body: string, chunk_size=10)
{	return new ResponseWithCookies(new RdStream(new MockConn(body, chunk_size)));
}

Deno.test
(	'Options',
	() =>
	{	const options = {maxConns: 10};
		const client = new Client(options);
		assertEquals(client.options().maxConns, options.maxConns);
	}
);

Deno.test
(	'RdStream',
	async () =>
	{	const BODY = get_random_string(20*1024);
		assertEquals(await (await get_mock_response(BODY, 10)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 1000)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 10*1024)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 30*1024)).text(), BODY);
	}
);

Deno.test
(	'Long body',
	async () =>
	{	const BODY = get_random_string(20*1024);
		const resp = await get_mock_response(BODY);
		const body_str = await resp.body?.text();
		assertEquals(body_str, BODY);
	}
);
