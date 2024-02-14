import {Client, ReadableReadableStream, ResponseWithCookies} from "../client.ts";
import {MockConn, get_random_string} from './mock/mod.ts';
import {assertEquals} from "https://deno.land/std@0.135.0/testing/asserts.ts";

async function get_mock_response(body: string, chunk_size=10)
{	return new ResponseWithCookies(new ReadableReadableStream(new MockConn(body, chunk_size)));
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
(	'ReadableReadableStream',
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
		const body_data = new Uint8Array(20*1024 + 100);
		let body_data_len = 0;
		if (resp.body)
		{	const buffer = new Uint8Array(10);
			while (true)
			{	const n = await resp.body.read(buffer);
				if (n == null)
				{	break;
				}
				body_data.set(buffer.subarray(0, n), body_data_len);
				body_data_len += n;
			}
		}
		const body_str = new TextDecoder().decode(body_data.subarray(0, body_data_len));
		assertEquals(body_str, BODY);
	}
);
