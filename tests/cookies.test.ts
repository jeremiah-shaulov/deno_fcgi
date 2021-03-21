import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {Cookies} from "../cookies.ts";
import {CookieError} from '../error.ts';

Deno.test
(	'Cookies 1',
	() =>
	{	let cookies = new Cookies('coo-1="val <1>"; coo-2=val <2>.');
		assertEquals(cookies.size, 2);
		assertEquals(cookies.get('coo-1'), 'val <1>');
		assertEquals(cookies.get('coo-2'), 'val <2>.');
		cookies.set('coo-1', 'New value', {domain: 'example.com'});
		assertEquals(cookies.size, 2);
		assert(cookies.has('coo-1'));
		assert(cookies.has('coo-2'));
		assertEquals(cookies.headers.size, 1);
		assertEquals(cookies.headers.get('coo-1'), 'coo-1=New%20value; Domain=example.com');
		cookies.clear();
		assertEquals(cookies.size, 0);
	}
);

Deno.test
(	'Cookies 2',
	() =>
	{	let cookies = new Cookies('coo-1="val <1>"; coo-2=val <2>.; ');
		assertEquals(cookies.size, 2);
		assertEquals(cookies.get('coo-1'), 'val <1>');
		assertEquals(cookies.get('coo-2'), 'val <2>.');
		cookies.set('coo[1]', 'val[1]', {path: '/', secure: true, httpOnly: true, sameSite: 'strict'});
		assertEquals(cookies.size, 3);
		assertEquals(cookies.headers.size, 1);
		assertEquals(cookies.headers.get('coo[1]'), 'coo%5B1%5D=val[1]; Path=/; Secure; HttpOnly; SameSite=strict');
		cookies.delete('fake');
		assertEquals(cookies.size, 3);
		cookies.delete('coo[1]');
		assertEquals(cookies.size, 2);
	}
);

Deno.test
(	'Cookies: unicode',
	() =>
	{	let cookies = new Cookies('א="א"; ב=ב;');
		assertEquals(cookies.size, 2);
		assertEquals(cookies.get('א'), 'א');
		assertEquals(cookies.get('ב'), 'ב');
		cookies.set('ג', 'ג', {path: '/'});
		assertEquals(cookies.size, 3);
		assertEquals(cookies.headers.size, 1);
		assertEquals(cookies.headers.get('ג'), `ג=ג; Path=/`); // PHP doesn't escape char-codes >=0x80 in cookie name, like i do, but it likes to escape such chars in value
	}
);

Deno.test
(	'Cookies: Max-Age',
	() =>
	{	let cookies = new Cookies('');
		assertEquals(cookies.size, 0);
		let now = Date.now();
		cookies.set('coo', 'val', {maxAge: 30});
		assertEquals(cookies.size, 1);
		assertEquals(cookies.headers.size, 1);
		let h = cookies.headers.get('coo');
		let expires;
		h = h?.replace(/Expires=([^;]+)/, (a, m) => {expires=m; return 'Expires='});
		assertEquals(h, 'coo=val; Expires=; Max-Age=30');
		assert(expires == new Date(now + 30_000).toUTCString() || expires == new Date(now + 29_000).toUTCString());
	}
);

Deno.test
(	'Cookies: Expires',
	() =>
	{	let cookies = new Cookies('');
		assertEquals(cookies.size, 0);
		let expires = new Date(Date.now() + 30_000);
		cookies.set('coo', 'val', {expires});
		assertEquals(cookies.size, 1);
		assertEquals(cookies.headers.size, 1);
		let h = cookies.headers.get('coo');
		let max_age;
		h = h?.replace(/Max-Age=([^;]+)/, (a, m) => {max_age=m; return 'Max-Age='});
		assertEquals(h, `coo=val; Expires=${expires.toUTCString()}; Max-Age=`);
		assert(max_age=='30' || max_age=='29');
	}
);

Deno.test
(	'Cookies: empty value',
	() =>
	{	let cookies = new Cookies('');
		assertEquals(cookies.size, 0);
		cookies.set('coo', '', {maxAge: 30});
		assertEquals(cookies.size, 0);
		assertEquals(cookies.headers.size, 1);
		assertEquals(cookies.headers.get('coo'), 'coo=deleted; Expires=Sat, 01 Jan 2000 00:00:00 GMT; Max-Age=0');
	}
);

Deno.test
(	'Cookies: invalid',
	() =>
	{	let cookies = new Cookies('');
		// invalid Domain
		let error;
		try
		{	cookies.set('coo', 'val', {domain: 'a;b'});
		}
		catch (e)
		{	error = e;
		}
		assert(error instanceof CookieError);
		// invalid Path
		error = undefined;
		try
		{	cookies.set('coo', 'val', {path: 'a;b'});
		}
		catch (e)
		{	error = e;
		}
		assert(error instanceof CookieError);
		// invalid SameSite
		error = undefined;
		try
		{	cookies.set('coo', 'val', {sameSite: 'a;b'});
		}
		catch (e)
		{	error = e;
		}
		assert(error instanceof CookieError);
	}
);

Deno.test
(	'Cookies: entries',
	() =>
	{	let cookies = new Cookies('coo-1="val <1>"; coo-2=val <2>.');
		cookies.set('coo-3', 'val <3>', {maxAge: 30});
		cookies.set('coo-1', '');
		assertEquals([...cookies.keys()], ['coo-2', 'coo-3']);
		assertEquals([...cookies.values()], ['val <2>.', 'val <3>']);
		assertEquals([...cookies.entries()], Object.entries({'coo-2': 'val <2>.', 'coo-3': 'val <3>'}));
		let all: any = {};
		cookies.forEach
		(	(v, k, map) =>
			{	assert(map == cookies);
				all[k] = v;
			}
		);
		assertEquals(all, {'coo-2': 'val <2>.', 'coo-3': 'val <3>'});
	}
);
