import {SetCookies} from "../set_cookies.ts";
import {assert, assertEquals} from "https://deno.land/std@0.113.0/testing/asserts.ts";

Deno.test
(	'Set-Cookies 1',
	() =>
	{	let cookies = new SetCookies;
		cookies.addSetCookie(new TextEncoder().encode('coo-1= val <1> ; secure'));
		cookies.addSetCookie(new TextEncoder().encode('coo-2')); // invalid
		cookies.addSetCookie(new TextEncoder().encode('coo-3=" a,b;c=d "; httponly'));
		cookies.addSetCookie(new TextEncoder().encode('coo-4="Hello all')); // invalid
		let expires = Date.now();
		cookies.addSetCookie(new TextEncoder().encode(`coo-5=val <5>.;\t \tdomain=www.example.com;path=/cgi-bin; expires=${new Date(expires).toUTCString()}`));
		cookies.addSetCookie(new TextEncoder().encode('coo-6="val <6>"; max-AGE=123'));
		assertEquals(cookies.size, 4);
		assertEquals(cookies.get('coo-1'), {value: ' val <1> ', options: {secure: true}});
		assertEquals(cookies.get('coo-3'), {value: ' a,b;c=d ', options: {httpOnly: true}});
		assertEquals(cookies.get('coo-5'), {value: 'val <5>.', options: {domain: 'www.example.com', path: '/cgi-bin', expires: new Date(expires - expires%1000)}});
		assertEquals(cookies.get('coo-6'), {value: 'val <6>', options: {maxAge: 123}});
	}
);
