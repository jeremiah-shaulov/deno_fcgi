import type {FcgiAddr} from "../addr.ts";
import {faddr_to_addr, addr_to_string, is_default_route} from "../addr.ts";
import {assert, assertEquals} from "https://deno.land/std@0.135.0/testing/asserts.ts";

Deno.test
(	'faddr_to_addr()',
	() =>
	{	const ADDRESSES = new Map<FcgiAddr, Deno.Addr>
		(	[	[0,						{transport: 'tcp', hostname: '0.0.0.0', port: 0}],
				['1',					{transport: 'tcp', hostname: '0.0.0.0', port: 1}],
				['127.0.0.1',			{transport: 'tcp', hostname: '127.0.0.1', port: 0}],
				['127.0.0.2:3',			{transport: 'tcp', hostname: '127.0.0.2', port: 3}],
				['localhost',			{transport: 'tcp', hostname: 'localhost', port: 0}],
				['localhost:5',			{transport: 'tcp', hostname: 'localhost', port: 5}],
				['::1',					{transport: 'tcp', hostname: '::1', port: 0}],
				['[::1]:7',				{transport: 'tcp', hostname: '::1', port: 7}],
				['/run/test/main.sock',	{transport: 'unix', path: '/run/test/main.sock'}],
			]
		);
		for (let [faddr, addr] of ADDRESSES)
		{	assertEquals(addr, faddr_to_addr(faddr));
		}
	}
);

Deno.test
(	'addr_to_string()',
	() =>
	{	const ADDRESSES = new Map<Deno.Addr, string>
		(	[	[{transport: 'tcp', hostname: '0.0.0.0', port: 0}, ':0'],
				[{transport: 'tcp', hostname: '0.0.0.0', port: 1}, ':1'],
				[{transport: 'tcp', hostname: '127.0.0.1', port: 0}, '127.0.0.1:0'],
				[{transport: 'tcp', hostname: '127.0.0.2', port: 3}, '127.0.0.2:3'],
				[{transport: 'tcp', hostname: 'localhost', port: 0}, 'localhost:0'],
				[{transport: 'tcp', hostname: 'localhost', port: 5}, 'localhost:5'],
				[{transport: 'tcp', hostname: '::1', port: 0}, '[::1]:0'],
				[{transport: 'tcp', hostname: '[::1]', port: 7}, '[::1]:7'],
				[{transport: 'unix', path: '/run/test/main.sock'}, '/run/test/main.sock'],
			]
		);
		for (let [addr, str] of ADDRESSES)
		{	assertEquals(str, addr_to_string(addr));
		}
		let error;
		try
		{	addr_to_string({transport: 'udp', hostname: '0.0.0.0', port: 0});
		}
		catch (e)
		{	error = e;
		}
		assert(error);
	}
);
