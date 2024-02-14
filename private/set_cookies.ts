import {CookieOptions} from "./cookies.ts";

const TAB = '\t'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const SEMICOLON = ';'.charCodeAt(0);
const QUOTE = '"'.charCodeAt(0);

const decoder = new TextDecoder;

export class SetCookies extends Map<string, {value: string, options: CookieOptions}>
{	addSetCookie(set_cookie: Uint8Array)
	{	let pos = set_cookie.indexOf(EQ);
		if (pos <= 0)
		{	return;
		}
		// 1. Read name
		const name = decodeURIComponent(decoder.decode(set_cookie.subarray(0, pos)));
		pos++;
		// 2. Read value
		let value;
		if (set_cookie[pos] === QUOTE)
		{	pos++;
			const qt = set_cookie.indexOf(QUOTE, pos);
			if (qt == -1)
			{	return;
			}
			value = decodeURIComponent(decoder.decode(set_cookie.subarray(pos, qt)));
			pos = qt + 1;
			if (set_cookie[pos] === SEMICOLON)
			{	pos++;
			}
		}
		else
		{	let semicolon = set_cookie.indexOf(SEMICOLON, pos);
			if (semicolon == -1)
			{	semicolon = set_cookie.length;
			}
			value = decodeURIComponent(decoder.decode(set_cookie.subarray(pos, semicolon)));
			pos = semicolon + 1;
		}
		// 3. Read flags: Expires, Max-Age, Domain, Path, HttpOnly, Secure, SameSite
		const options: CookieOptions = {};
		while (pos < set_cookie.length)
		{	// skip space after ';'
			while (set_cookie[pos]===SPACE || set_cookie[pos]===TAB)
			{	pos++;
			}
			// find next ';'
			let semicolon = set_cookie.indexOf(SEMICOLON, pos);
			if (semicolon == -1)
			{	semicolon = set_cookie.length;
			}
			// interpret the flag
			switch (set_cookie[pos])
			{	case 'e'.charCodeAt(0):
				case 'E'.charCodeAt(0):
				{	const eq = pos + 'expires'.length;
					if (set_cookie[eq] === EQ && decoder.decode(set_cookie.subarray(pos, eq)).toLowerCase() == 'expires')
					{	options.expires = new Date(Date.parse(decoder.decode(set_cookie.subarray(eq+1, semicolon))));
					}
					break;
				}
				case 'm'.charCodeAt(0):
				case 'M'.charCodeAt(0):
				{	const eq = pos + 'max-age'.length;
					if (set_cookie[eq] === EQ && decoder.decode(set_cookie.subarray(pos, eq)).toLowerCase() == 'max-age')
					{	options.maxAge = Number(decoder.decode(set_cookie.subarray(eq+1, semicolon)));
					}
					break;
				}
				case 'd'.charCodeAt(0):
				case 'D'.charCodeAt(0):
				{	const eq = pos + 'domain'.length;
					if (set_cookie[eq] === EQ && decoder.decode(set_cookie.subarray(pos, eq)).toLowerCase() == 'domain')
					{	options.domain = decoder.decode(set_cookie.subarray(eq+1, semicolon));
					}
					break;
				}
				case 'p'.charCodeAt(0):
				case 'P'.charCodeAt(0):
				{	const eq = pos + 'path'.length;
					if (set_cookie[eq] === EQ && decoder.decode(set_cookie.subarray(pos, eq)).toLowerCase() == 'path')
					{	options.path = decoder.decode(set_cookie.subarray(eq+1, semicolon));
					}
					break;
				}
				case 'h'.charCodeAt(0):
				case 'H'.charCodeAt(0):
				{	if (semicolon-pos == 'httponly'.length && decoder.decode(set_cookie.subarray(pos, semicolon)).toLowerCase() == 'httponly')
					{	options.httpOnly = true;
					}
					break;
				}
				case 's'.charCodeAt(0):
				case 'S'.charCodeAt(0):
				{	if (semicolon-pos == 'secure'.length)
					{	if (decoder.decode(set_cookie.subarray(pos, semicolon)).toLowerCase() == 'secure')
						{	options.secure = true;
						}
					}
					else
					{	const eq = pos + 'samesite'.length;
						if (set_cookie[eq] === EQ && decoder.decode(set_cookie.subarray(pos, eq)).toLowerCase() == 'samesite')
						{	options.sameSite = decoder.decode(set_cookie.subarray(eq+1, semicolon));
						}
					}
					break;
				}
			}
			// step after the next ';'
			pos = semicolon + 1;
		}
		this.set(name, {value, options});
	}
}
