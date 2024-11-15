import {Reader} from './deno_ifaces.ts';
import {SetCookies} from './set_cookies.ts';

export interface ServerResponse
{	status?: number;
	headers?: Headers;
	setCookies?: SetCookies,
	body?: Uint8Array | Reader | string;
	trailers?: () => Promise<Headers> | Headers;
}
