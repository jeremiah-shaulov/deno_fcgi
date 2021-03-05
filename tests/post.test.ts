import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {Post} from "../post.ts";

class StringReader
{	private buffer: Uint8Array;
	private pos = 0;

	constructor(private str: string)
	{	this.buffer = new TextEncoder().encode(str);
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	if (this.pos == this.buffer.length)
		{	return null;
		}
		let chunk_size = Math.min(this.buffer.length-this.pos, buffer.length);
		buffer.set(this.buffer.subarray(this.pos, this.pos+chunk_size));
		this.pos += chunk_size;
		return chunk_size;
	}
}

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
(	'1',
	async () =>
	{	let post = new Post(new StringReader('item[]=v0&item[1]=v1&item[]=v2&item[amount]=10'), 'application/x-www-form-urlencoded', '', 0, true);
		await post.parse();
		assertEquals(map_to_obj(post), {item: {'0': 'v0', '1': 'v1', '2': 'v2', amount: '10'}});
	}
);

Deno.test
(	'2',
	async () =>
	{	let data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
		);
		let post = new Post(new StringReader(data), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', 237, true);
		await post.parse();
		assertEquals(map_to_obj(post), {name: 'Orange', weight: '0.3'});
	}
);
