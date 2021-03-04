export interface ServerResponse
{	status?: number;
	headers?: Headers;
	body?: Uint8Array | Deno.Reader | string;
	trailers?: () => Promise<Headers> | Headers;
}
