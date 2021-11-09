import {SetCookies} from "./set_cookies.ts";

export interface ServerResponse
{	status?: number;
	headers?: Headers;
	setCookies?: SetCookies,
	body?: Uint8Array | Deno.Reader | string;
	trailers?: () => Promise<Headers> | Headers;
}
