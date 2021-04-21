import {CookieError} from './error.ts';

const COOKIE_NAME_MASK = get_cookie_name_mask();
const COOKIE_VALUE_MASK = get_cookie_value_mask();

/**	According to RFC, the following chars are forbidden: \x00-\x20, spaces, ()<>@,;:\"/[]?={}
	Forbidden codes: 0..32, 32, 34, 40, 41, 44, 47, 58, 59, 60, 61, 62, 63, 64, 91, 92, 93, 123, 125
 **/
function get_cookie_name_mask()
{	const mask = new Uint8Array(128);
	for (let i=0; i<=32; i++)
	{	mask[i] = 1;
	}
	mask[34] = 1;
	mask[40] = 1;
	mask[41] = 1;
	mask[44] = 1;
	mask[47] = 1;
	for (let i=58; i<=64; i++)
	{	mask[i] = 1;
	}
	mask[91] = 1;
	mask[92] = 1;
	mask[93] = 1;
	mask[123] = 1;
	mask[125] = 1;
	return mask;
}

/**	According to RFC, the following chars are forbidden: \x00-\x20, spaces, ",;\
	Forbidden codes: 0..32, 32, 34, 44, 59, 92
 **/
function get_cookie_value_mask()
{	const mask = new Uint8Array(128);
	for (let i=0; i<=32; i++)
	{	mask[i] = 1;
	}
	mask[34] = 1;
	mask[44] = 1;
	mask[59] = 1;
	mask[92] = 1;
	return mask;
}

export interface CookieOptions
{	expires?: Date,
	maxAge?: number,
	domain?: string,
	path?: string,
	secure?: boolean,
	httpOnly?: boolean,
	sameSite?: string,
}

export class Cookies extends Map<string, string>
{	public headers = new Map<string, string>();

	private is_inited = false;

	constructor(private cookie_header='')
	{	super();
	}

	setHeader(cookie_header: string)
	{	this.cookie_header = cookie_header;
		this.is_inited = false;
		super.clear();
		this.headers.clear();
	}

	get size()
	{	this.init();
		return super.size;
	}

	clear()
	{	this.setHeader('');
	}

	/// According to RFC https://tools.ietf.org/html/rfc6265#section-5.4 the delimiter must be '; '
	private init()
	{	if (!this.is_inited)
		{	this.is_inited = true;
			let {cookie_header} = this;
			this.cookie_header = ''; // free memory
			let i = 0;
			while (i < cookie_header.length)
			{	let i_end = cookie_header.indexOf('=', i);
				if (i_end == -1)
				{	break;
				}
				let name = cookie_header.slice(i, i_end);
				i = i_end + 1;
				i_end = cookie_header.indexOf(';', i);
				if (i_end == -1)
				{	i_end = cookie_header.length;
				}
				let value = decodeURIComponent(cookie_header.slice(i, i_end));
				super.set(name, value);
				i = i_end + 2; // skip the '; ' delimiter
			}
		}
	}

	has(name: string)
	{	this.init();
		return super.has(name);
	}

	get(name: string)
	{	this.init();
		return super.get(name);
	}

	set(name: string, value: string, options?: CookieOptions)
	{	if (value.length == 0)
		{	this.delete(name);
		}
		else
		{	this.init();
			super.set(name, value);
			let str = encode_cookie(name, COOKIE_NAME_MASK)+'='+encode_cookie(value, COOKIE_VALUE_MASK);
			if (options)
			{	let {expires, maxAge, domain, path, secure, httpOnly, sameSite} = options;
				if (maxAge != undefined)
				{	expires = new Date(Date.now() + maxAge*1000);
				}
				else if (expires)
				{	maxAge = Math.ceil((expires.getTime() - Date.now()) / 1000);
				}
				if (expires)
				{	str += `; Expires=${expires.toUTCString()}; Max-Age=${maxAge}`;
				}
				if (domain)
				{	if (domain.indexOf(';') != -1)
					{	throw new CookieError('Domain name in cookie cannot contain semicolon');
					}
					str += `; Domain=${domain}`;
				}
				if (path)
				{	if (path.indexOf(';') != -1)
					{	throw new CookieError('Path in cookie cannot contain semicolon');
					}
					str += `; Path=${path}`;
				}
				if (secure)
				{	str += `; Secure`;
				}
				if (httpOnly)
				{	str += `; HttpOnly`;
				}
				if (sameSite)
				{	if (sameSite.indexOf(';') != -1)
					{	throw new CookieError('SameSite in cookie must be one of: Strict, Lax, None');
					}
					str += `; SameSite=${sameSite}`;
				}
			}
			this.headers.set(name, str);
		}
		return this;
	}

	delete(name: string)
	{	this.init();
		let str = encode_cookie(name, COOKIE_NAME_MASK)+'=deleted; Expires=Sat, 01 Jan 2000 00:00:00 GMT; Max-Age=0';
		this.headers.set(name, str);
		return super.delete(name);
	}

	entries()
	{	this.init();
		return super.entries();
	}

	keys()
	{	this.init();
		return super.keys();
	}

	values()
	{	this.init();
		return super.values();
	}

	forEach(callback: (value: string, key: string, map: Map<string, string>) => void, thisArg?: any)
	{	this.init();
		return super.forEach(callback, thisArg);
	}

	[Symbol.iterator]()
	{	this.init();
		return super[Symbol.iterator]();
	}
}

function encode_cookie(value: string, mask: Uint8Array)
{	for (let i=0, i_end=value.length; i<i_end; i++)
	{	let c = value.charCodeAt(i);
		if (c<=127 && mask[c]==1)
		{	// there's invalid char at "i"
			let new_value = value.slice(0, i); // cannot return "value" as is, so create "new_value"
			while (i < i_end)
			{	// new_value += invalid range
				let from = i;
				for (i++; i<i_end; i++)
				{	c = value.charCodeAt(i);
					if (c>127 || mask[c]!=1)
					{	break;
					}
				}
				new_value += encodeURIComponent(value.slice(from, i));
				// new_value += valid range
				from = i;
				for (i++; i<i_end; i++)
				{	c = value.charCodeAt(i);
					if (c<=127 && mask[c]==1)
					{	break;
					}
				}
				new_value += value.slice(from, i);
			}
			return new_value;
		}
	}
	// all chars are valid
	return value;
}
