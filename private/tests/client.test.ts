import {Client, ReadableReadableStream, ResponseWithCookies} from "../client.ts";
import {MockConn, get_random_string} from './mock/mod.ts';
import {assert, assertEquals} from "https://deno.land/std@0.113.0/testing/asserts.ts";

async function get_mock_response(body: string, first_part_len=1024, first_part_chunk_size=100, chunk_size=10, fail=false)
{	let conn = new MockConn(body, first_part_chunk_size);
	async function *body_it(buffer: Uint8Array)
	{	while (true)
		{	let n = await conn.read(buffer);
			if (n == null)
			{	break;
			}
			conn.chunk_size = chunk_size;
			buffer = yield n;
			if (fail)
			{	throw new Error('failed');
			}
		}
		return 0;
	}
	let buffer = new Uint8Array(first_part_len);
	let it = body_it(buffer);
	let {value: n_read, done} = await it.next(buffer);
	buffer = buffer.subarray(0, done ? 0 : n_read as number);
	return new ResponseWithCookies(new ReadableReadableStream(buffer, it, () => {}));
}

Deno.test
(	'Options',
	() =>
	{	let options = {maxConns: 10};
		let client = new Client(options);
		assertEquals(client.options().maxConns, options.maxConns);
	}
);

Deno.test
(	'ReadableReadableStream',
	async () =>
	{	let BODY = get_random_string(20*1024);
		assertEquals(await (await get_mock_response(BODY, 0, 10, 10)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 100, 100, 10)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 10*1024, 100, 100)).text(), BODY);
		assertEquals(await (await get_mock_response(BODY, 30*1024, 100, 100)).text(), BODY);
		let error;
		try
		{	await (await get_mock_response(BODY, 0, 100, 10, true)).text();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'failed');
	}
);

Deno.test
(	'Long body',
	async () =>
	{	let BODY = get_random_string(20*1024);
		let resp = await get_mock_response(BODY);
		let body_data = new Uint8Array(20*1024 + 100);
		let body_data_len = 0;
		if (resp.body)
		{	let buffer = new Uint8Array(10);
			while (true)
			{	let n = await resp.body.read(buffer);
				if (n == null)
				{	break;
				}
				body_data.set(buffer.subarray(0, n), body_data_len);
				body_data_len += n;
			}
		}
		let body_str = new TextDecoder().decode(body_data.subarray(0, body_data_len));
		assertEquals(body_str, BODY);
	}
);
