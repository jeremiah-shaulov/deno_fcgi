import {ServerRequest} from './server_request.ts';
import {pathToRegexp} from './deps.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Callback = (request: ServerRequest, params: Any) => Promise<unknown>;
export type PathPattern = string | string[] | RegExp;
type Route = {addr_str: string, regexp: RegExp | undefined, param_names: string[], callback: Callback};

export class Routes extends Map<string, Map<string, Route[]>>
{	add_route(addr_str: string, path_pattern: PathPattern, callback: Callback)
	{	let prefix = '';
		let suffix = '';
		let regexp: RegExp | undefined;
		let param_names = new Array<string>;
		if (path_pattern)
		{	const params = new Array<{name: string}>;
			regexp = pathToRegexp(path_pattern, params as Any);
			param_names = params.map(v => v.name);
			let {source} = regexp;
			const re_prefix = source.match(/^(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*/)![0];
			const re_suffix = source.slice(re_prefix.length).match(/(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*$/)![0];
			source = source.slice(re_prefix.length, source.length-re_suffix.length);
			regexp = source ? new RegExp(source, regexp.flags) : undefined;
			prefix = re_prefix.replace(/\\[\S\s]/g, m => m.charAt(1));
			suffix = re_suffix.replace(/\\[\S\s]/g, m => m.charAt(1));
		}
		// add
		let level_1 = this.get(prefix);
		if (level_1 == undefined)
		{	level_1 = new Map<string, Route[]>();
			this.set(prefix, level_1);
		}
		let level_2 = level_1.get(suffix);
		if (level_2 == undefined)
		{	level_2 = [];
			level_1.set(suffix, level_2);
		}
		level_2.push({addr_str, regexp, param_names, callback});
	}

	*get_callback_and_params(addr_str: string, path: string)
	{	for (const [prefix, level_1] of this)
		{	if (path.startsWith(prefix))
			{	for (const [suffix, level_2] of level_1)
				{	if (path.endsWith(suffix))
					{	for (const {addr_str: a, regexp, param_names, callback} of level_2)
						{	if (a == (a.charAt(0)!=':' ? addr_str : addr_str.slice(addr_str.indexOf(':'))))
							{	if (!regexp)
								{	yield {callback, params: {}};
								}
								else
								{	const m = path.match(regexp);
									if (m)
									{	const params: Any = {};
										for (let i=0, i_end=param_names.length; i<i_end; i++)
										{	params[param_names[i]] = m[i+1];
										}
										yield {callback, params};
									}
								}
							}
						}
					}
				}
			}
		}
	}

	remove_addr(addr_str: string)
	{	const to_remove_0 = [];
		for (const [prefix, level_1] of this)
		{	const to_remove_1 = [];
			for (const [suffix, level_2] of level_1)
			{	for (let i=level_2.length-1; i>=0; i--)
				{	if (level_2[i].addr_str == addr_str)
					{	level_2.splice(i, 1);
					}
				}
				if (level_2.length == 0)
				{	to_remove_1.push(suffix);
				}
			}
			for (const suffix of to_remove_1)
			{	level_1.delete(suffix);
			}
			if (level_1.size == 0)
			{	to_remove_0.push(prefix);
			}
		}
		for (const prefix of to_remove_0)
		{	this.delete(prefix);
		}
	}
}
