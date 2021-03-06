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

	private init()
	{	if (!this.is_inited)
		{	this.is_inited = true;
			let {cookie_header} = this;
			this.cookie_header = ''; // free memory
			let i = 0;
			while (i < cookie_header.length)
			{	let i_end = cookie_header.indexOf(';', i);
				if (i_end == -1)
				{	i_end = cookie_header.length;
				}
				let eq = cookie_header.indexOf('=', i);
				if (eq<i_end && eq!=-1)
				{	let name = decodeURIComponent(cookie_header.slice(i, eq));
					let value = decodeURIComponent(cookie_header.slice(eq+1, i_end));
					super.set(name, value);
				}
				i = i_end + 1;
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
	{	this.init();
		super.set(name, value);
		let str = encodeURIComponent(name)+'='+encodeURIComponent(value);
		if (options)
		{	let {expires, maxAge, domain, path, secure, httpOnly, sameSite} = options;
			if (maxAge != undefined)
			{	expires = new Date(Date.now() + maxAge*1000);
			}
			else if (expires)
			{	maxAge = expires.getTime() - Date.now();
			}
			if (expires)
			{	str += `; expires=${expires.toUTCString()}; max-age=${maxAge}`;
			}
			if (domain)
			{	str += `; domain=${encodeURIComponent(domain)}`;
			}
			if (path)
			{	str += `; domain=${encodeURIComponent(path)}`;
			}
			if (secure)
			{	str += `; secure`;
			}
			if (httpOnly)
			{	str += `; httponly`;
			}
			if (sameSite)
			{	str += `; samesite`;
			}
		}
		this.headers.set(name, str);
		return this;
	}

	delete(name: string)
	{	this.init();
		if (!super.delete(name))
		{	return false;
		}
		let str = encodeURIComponent(name)+'=; expires=Sat, 01 Jan 2000 00:00:00 GMT; max-age=0';
		this.headers.set(name, str);
		return true;
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
}
