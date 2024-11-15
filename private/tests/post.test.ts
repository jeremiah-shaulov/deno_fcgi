import {Post} from '../post.ts';
import {TEST_CHUNK_SIZES, get_random_string, map_to_obj, MockConn} from './mock/mod.ts';
import {assert} from 'jsr:@std/assert@1.0.7/assert';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

/**	File exists? If yes, return it's `stat`.
 **/
export async function exists(filespec: string|URL)
{	try
	{	return await Deno.stat(filespec);
	}
	catch (e)
	{	if (!(e instanceof Deno.errors.NotFound))
		{	throw e;
		}
	}
}

Deno.test
(	'Urlencoded',
	async () =>
	{	for (const chunk_size of TEST_CHUNK_SIZES)
		{	const post = new Post(new MockConn('item[]=v0&item[1]=v1&item[]=v2&item[amount]=10', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true);
			assert(await post.parse());
			assertEquals(map_to_obj(post), {item: {'0': 'v0', '1': 'v1', '2': 'v2', amount: '10'}});
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'Urlencoded long name',
	async () =>
	{	for (const chunk_size of TEST_CHUNK_SIZES)
		{	const post = new Post(new MockConn('123=v0&1234=v1&12345=v2', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true, 3);
			assert(!await post.parse());
			assertEquals(map_to_obj(post), {'123': 'v0'});
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'Urlencoded long value',
	async () =>
	{	for (const chunk_size of TEST_CHUNK_SIZES)
		{	const post = new Post(new MockConn('item[]=12345&item[]=123&item[]=1234', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true, 100, 4);
			assert(!await post.parse());
			assertEquals(map_to_obj(post), {item: {'0': '123', '1': '1234'}});
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'Form-data',
	async () =>
	{	const data =
		(	'------------------------------------IGNORE Line 1\r\n'+
			'------------------------------------IGNORE Line 2\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const data_arr = [data, data+'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'];

		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (const data of data_arr)
			{	const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				assert(await post.parse());
				assertEquals(map_to_obj(post), {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 0);
				await post.close();
			}
		}
	}
);

Deno.test
(	'Incomplete header',
	async () =>
	{	const data =
		(	'IGNORE'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'
		);

		for (const chunk_size of TEST_CHUNK_SIZES)
		{	const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
			assert(!await post.parse());
			assertEquals(post.size, 0);
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'Form-data file',
	async () =>
	{	const weight =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	const file_contents = 'ABC\r\nDEF\nGHI';
				const data =
				(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
					'Content-Disposition: form-data; name="name"\r\n'+
					'\r\n'+
					'Orange\r\n'+
					'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
					'Content-Disposition: form-data; name="main image"; filename="/tmp/current_file"\r\n'+
					(i==0 ? 'Content-Type: text/plain\r\n' : '')+
					'\r\n'+
					file_contents+'\r\n'+
					(i==0 ? '' : weight)+
					'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
				);

				const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				assert(await post.parse());
				assertEquals(map_to_obj(post), i==0 ? {name: 'Orange'} : {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 1);
				const uploaded_file = post.files.get('main image');
				const tmpName = uploaded_file?.tmpName;
				assert(tmpName);
				const contents = await Deno.readTextFile(tmpName);
				assertEquals(contents, file_contents);
				assertEquals({...uploaded_file}, {error: 0, name: '/tmp/current_file', size: file_contents.length, tmpName: uploaded_file!.tmpName, type: i==0 ? 'text/plain' : 'application/octet-stream'});
				if (i == 1)
				{	await Deno.remove(tmpName); // delete before closing "post"
					assert(!await exists(tmpName));
				}
				await post.close();
				assert(!await exists(tmpName));
			}
		}
	}
);

Deno.test
(	'Form-data too long name',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const data_arr = [data, data+'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'];

		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (const data of data_arr)
			{	const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 4);
				assert(await post.parse());
				assertEquals(map_to_obj(post), {name: 'Orange'});
				assertEquals(post.files.size, 0);
				await post.close();
			}
		}
	}
);

Deno.test
(	'Form-data too long value',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const data_arr = [data, data+'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'];

		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (const data of data_arr)
			{	for (const i of [2, 3, 5, 6])
				{	const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, i);
					assert(await post.parse());
					if (i == 2)
					{	assertEquals(map_to_obj(post), {});
					}
					else if (i==3 || i==5)
					{	assertEquals(map_to_obj(post), {weight: '0.3'});
					}
					else if (i == 6)
					{	assertEquals(map_to_obj(post), {name: 'Orange', weight: '0.3'});
					}
					assertEquals(post.files.size, 0);
					await post.close();
				}
			}
		}
	}
);

Deno.test
(	'Form-data too long file',
	async () =>
	{	const file_contents = 'ABC\r\nDEF\nGHI';
		const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="main image"; filename="/tmp/current_file"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
		);
		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	const post = new Post(new MockConn(data, chunk_size), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100, i==0 ? file_contents.length-1 : file_contents.length);
				const parse_ok = await post.parse();
				assertEquals(parse_ok, i==1);
				assertEquals(map_to_obj(post), {name: 'Orange'});
				assertEquals(post.files.size, 1);
				const uploaded_file = post.files.get('main image');
				const tmpName = uploaded_file?.tmpName;
				assert(i==0 ? !tmpName : tmpName);
				if (tmpName)
				{	const contents = await Deno.readTextFile(tmpName);
					assertEquals(contents, file_contents);
					uploaded_file!.tmpName = '';
					assertEquals({...uploaded_file}, {error: 0, name: '/tmp/current_file', size: file_contents.length, tmpName: '', type: 'application/octet-stream'});
				}
				else
				{	assertEquals({...uploaded_file}, {error: 7, name: '/tmp/current_file', size: file_contents.length, tmpName: '', type: 'application/octet-stream'});
				}
				await post.close();
				assert(!tmpName || !await exists(tmpName));
			}
		}
	}
);

Deno.test
(	'Form-data long file',
	async () =>
	{	const file_contents = [get_random_string(8*1024 - 300), get_random_string(8*1024 - 300), get_random_string(100)];
		const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="file 0"; filename="/tmp/file_0"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents[0]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="file 1"; filename="/tmp/file_1"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents[1]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="field 2"\r\n'+
			'\r\n'+
			file_contents[2]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
		);
		const post = new Post(new MockConn(data, 10000), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, file_contents[2].length, Math.max(...file_contents.map(v => v.length)));
		assert(await post.parse());
		assertEquals(map_to_obj(post), {name: 'Orange', 'field 2': file_contents[2]});
		assertEquals(post.files.size, 2);
		const tmp_names = [];
		for (let i=0; i<2; i++)
		{	const uploaded_file = post.files.get('file '+i);
			const tmpName = uploaded_file?.tmpName;
			assert(tmpName);
			tmp_names[i] = tmpName;
			const contents = await Deno.readTextFile(tmpName);
			assertEquals(contents, file_contents[i]);
			uploaded_file!.tmpName = '';
			assertEquals({...uploaded_file}, {error: 0, name: '/tmp/file_'+i, size: file_contents[i].length, tmpName: '', type: 'application/octet-stream'});
		}
		await post.close();
		for (let i=0; i<2; i++)
		{	assert(!await exists(tmp_names[i]));
		}
	}
);

Deno.test
(	'Form-data long value',
	async () =>
	{	const params = {par0: get_random_string(8*1024 - 300), par1: get_random_string(8*1024 - 300), par2: get_random_string(100), par3: ''};
		const data = `par0=${encodeURIComponent(params.par0)}&par1=${encodeURIComponent(params.par1)}&par2=${encodeURIComponent(params.par2)}&par3`;
		const post = new Post(new MockConn(data, 10000), () => {}, 'application/x-www-form-urlencoded', '', data.length, true, 100, 8*1024);
		assert(await post.parse());
		assertEquals(map_to_obj(post), params);
		await post.close();
	}
);

Deno.test
(	'Invalid',
	async () =>
	{	for (const chunk_size of TEST_CHUNK_SIZES)
		{	const post = new Post(new MockConn('a[=1&b[KEY][...=2&c=3&d[[[', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true);
			assert(!await post.parse());
			assertEquals(map_to_obj(post), {a: '1', b: {KEY: '2'}, c: '3', d: ''});
			assertEquals(post.files.size, 0);
			await post.close();
		}
		// no boundary
		let data = 'Hello';
		let post = new Post(new MockConn(data), () => {}, 'multipart/form-data', '', data.length);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
		// no fields after first boundary
		post = new Post(new MockConn(data), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
		// incomplete header
		data = '------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\nContent-Disposition: form-data; ';
		post = new Post(new MockConn(data, 300), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
		// no even ':'
		data = '------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\nContent-Disposition ha-ha-ha\r\n';
		post = new Post(new MockConn(data, 300), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
		// line starts with ":" or "\n"
		data = '------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n::\r\n';
		post = new Post(new MockConn(data, 300), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
	}
);

Deno.test
(	'POST form-data header is too long',
	async () =>
	{	const data =
		(	'IGNORE'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="'+get_random_string(8*1024-100)+'"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="'+get_random_string(512*2)+'"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);

		const post = new Post(new MockConn(data, 300), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
		assert(!await post.parse());
		assertEquals(post.size, 0);
		assertEquals(post.files.size, 0);
		await post.close();
	}
);

Deno.test
(	'No LF after CR',
	async () =>
	{	let data =
		(	'IGNORE'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r'
		);

		for (let i=0; i<2; i++)
		{	const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
			assert(!await post.parse());
			assertEquals(map_to_obj(post), {name: 'Orange'});
			assertEquals(post.files.size, 0);
			await post.close();
			data += ' ';
		}
	}
);

Deno.test
(	'No CRLF after value and before boundary',
	async () =>
	{	const data_set = [];
		for (let i=0; i<2; i++)
		{	data_set[i] =
			(	'IGNORE'+
				'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
				'Content-Disposition: form-data; name="name"'+(i==0 ? '' : '; filename="/tmp/current_file"')+'\r\n'+
				'\r\n'+
				'Orange'+ // no \r\n
				'------WebKitFormBoundaryAmvtsvCs9WGC03jH'
			);
		}

		for (const chunk_size of TEST_CHUNK_SIZES)
		{	for (const data of data_set)
			{	const post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				assert(!await post.parse());
				assertEquals(post.size, 0);
				assertEquals(post.files.size, 0);
				await post.close();
			}
		}
	}
);

Deno.test
(	'No semicolon in Content-Disposition',
	async () =>
	{	for (let i=0; i<2; i++)
		{	const data =
			(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
				'Content-Disposition: form-data; name="name"\r\n'+
				'\r\n'+
				'Orange\r\n'+
				'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
				'Content-Disposition: form-data'+(i==0 ? ';' : '')+' name="weight"\r\n'+
				'\r\n'+
				'0.3\r\n'
			);
			const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100);
			assert((await post.parse()) ? i==0 : i==1);
			assertEquals(map_to_obj(post), i==0 ? {'name': 'Orange', 'weight': '0.3'} : {'name': 'Orange'});
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'No quotes in Content-Disposition',
	async () =>
	{	for (let i=0; i<2; i++)
		{	const data =
			(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
				'Content-Disposition: form-data; name="name"\r\n'+
				'\r\n'+
				'Orange\r\n'+
				'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
				'Content-Disposition: form-data; name="weight"; filename='+(i==0 ? '"/tmp/current_file"' : '/tmp/current_file')+'\r\n'+
				'\r\n'+
				'0.3\r\n'
			);
			const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100);
			assert(await post.parse());
			assertEquals(map_to_obj(post), i==0 ? {'name': 'Orange'} : {'name': 'Orange', 'weight': '0.3'});
			assertEquals(post.files.size, i==0 ? 1 : 0);
			await post.close();
		}
	}
);

Deno.test
(	'No backslash in Content-Disposition',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name \\"qt\\""\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight \\"qt\\""; filename="C:\\\\tmp\\\\current_file"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100);
		assert(await post.parse());
		assertEquals(map_to_obj(post), {'name "qt"': 'Orange'});
		assertEquals(post.files.size, 1);
		assertEquals(post.files.get('weight "qt"')?.name, 'C:\\tmp\\current_file');
		await post.close();
	}
);

Deno.test
(	'Invalid backslash in Content-Disposition',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight\\"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100);
		assert(await post.parse());
		assertEquals(map_to_obj(post), {'name': 'Orange'});
		assertEquals(post.files.size, 0);
		await post.close();
	}
);

Deno.test
(	'Extremely long value',
	async () =>
	{	const LEN = 10000;
		const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			get_random_string(LEN)+'\r\n'
		);
		for (let i=0; i<2; i++)
		{	const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, i==0 ? 1 : LEN);
			assert((await post.parse()) ? i==1 : i==0);
			assertEquals(post.size, i);
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);

Deno.test
(	'Invalid structured path',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name["\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 1000);
		assert(!await post.parse());
		assertEquals(map_to_obj(post), {'name': 'Orange', 'weight': '0.3'});
		assertEquals(post.files.size, 0);
		await post.close();
	}
);

Deno.test
(	'Invalid Content-Length',
	async () =>
	{	const data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Hello\r\n'
		);
		for (let i=0; i<2; i++)
		{	const post = new Post(new MockConn(data, 1000), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length+i, true, 100, 100);
			assert((await post.parse()) ? i==0 : i==1);
			assertEquals(map_to_obj(post), {'name': 'Hello'});
			assertEquals(post.files.size, 0);
			await post.close();
		}
	}
);
