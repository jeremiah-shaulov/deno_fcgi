import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {Post} from "../post.ts";
import {TEST_CHUNK_SIZES, MockServer} from './mock.ts';

function map_to_obj(map: any)
{	let j = JSON.stringify
	(	map,
		(k, v) =>
		{	if (v instanceof Map)
			{	let obj: any = {};
				for (let [mk, mv] of v)
				{	obj[mk] = mv;
				}
				v = obj;
			}
			return v;
		}
	);
	return JSON.parse(j);
}

Deno.test
(	'Basic request',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<4; i++)
			{	let server = new MockServer({}, chunk_size, i%2==0, i>=2);
				// write
				server.pend_read_fcgi_begin_request(1, 'responder', false);
				server.pend_read_fcgi_params(1, {HELLO: 'all'});
				server.pend_read_fcgi_stdin(1, 'Body');
				// accept
				let req = await server.accept();
				// check
				assertEquals(map_to_obj(req.params), {HELLO: 'all'});
				// respond
				await req.respond();
				assert(server.is_retired);
			}
		}
	}
);
