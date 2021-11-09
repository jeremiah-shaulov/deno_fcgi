export function get_random_bytes(length: number)
{	let buffer = new Uint8Array(length);
	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = 32 + Math.floor(Math.random()*90);
	}
	return buffer;
}

export function get_random_string(length: number)
{	return new TextDecoder().decode(get_random_bytes(length));
}

export function map_to_obj(map: any)
{	let j = JSON.stringify
	(	map,
		(k, v) =>
		{	if (v instanceof Map || v instanceof Headers)
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
