import {exists} from "https://deno.land/std/fs/mod.ts";
import {assert} from "./assert.ts";
import {StructuredMap} from "./structured_map.ts";

const BUFFER_LEN = 8*1024;
const REALLOC_THRESHOLD = 256; // max length for header line like `Content-Disposition: form-data; name="image"; filename="/tmp/current_file"` is BUFFER_LEN-REALLOC_THRESHOLD
const MAX_BOUNDARY_LEN = 100;

const UPLOAD_ERR_OK = 0;
const UPLOAD_ERR_CANT_WRITE = 7;

const AMP = '&'.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const SEMICOLON = ';'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);

const RE_HEADER_VALUE = /\s*(\w+)="([^"]+)"(?:;|$)/g;

assert(MAX_BOUNDARY_LEN+2 <= BUFFER_LEN); // (boundary + "\r\n").length

export class UploadedFile
{	constructor(public name='', public type='', public size=0, public tmpName='', public error=0)
	{
	}
}

export class Post extends StructuredMap
{	/// Was parse() called?
	public isParsed = false;
	/// Uploaded files are stored to temporary files that will be deleted at the end of request. You can read them, or move to a different location (from where they will not be deleted).
	public files = new Map<string, UploadedFile>();

	private is_parse_error = false;
	private uploaded_files: string[] = [];

	constructor
	(	private reader: Deno.Reader,
		/// Post body "Content-Type". Lowercased, and part starting with ';' is cut (if any)
		public contentType = '',
		/// If contentType is 'multipart/form-data', this will be data boundary.
		public formDataBoundary = '',
		/// the "Content-Length" HTTP header
		public contentLength = -1,
		/// Parse params like "items[]=a&items[]=b" and "items[a][b]=c" to Map objects, like PHP does.
		public structuredParams = false,
		/// Parameters with longer names will be ignored.
		public maxNameLength = 256,
		/// Parameters with longer values will be ignored.
		public maxValueLength = 10*1024,
		/// Uploaded files bigger than this will be ignored.
		public maxFileSize = 10*1024*1024,
		/// What decoder to use to decode bytes of the post data (not for uploaded files - they are written binary as is)
		public decoder = new TextDecoder
	)
	{	super(structuredParams);
	}

	close()
	{	let promises = [];
		for (let f of this.uploaded_files)
		{	promises[promises.length] = exists(f).then(yes => yes ? Deno.remove(f) : null).catch(e => console.error(e));
		}
		this.uploaded_files.length = 0;
		return Promise.all(promises);
	}

	/**	Reads POST body, and tries to parse it according to `contentType`.
		The following content types are supported: `application/x-www-form-urlencoded`, `multipart/form-data`.

		The object is empty before this method called. It can be called many times (next calls do nothing).
		`isParsed` is set regardless of errors.

		Returns true if parsed successfully, and false if invalid format. On I/O errors throws exception.
	 **/
	async parse()
	{	if (!this.isParsed)
		{	this.isParsed = true;
			if (this.contentType == 'application/x-www-form-urlencoded')
			{	this.is_parse_error = await this.parse_urlencoded();
			}
			else if (this.contentType == 'multipart/form-data')
			{	this.is_parse_error = await this.parse_mulpipart_form_data();
			}
		}
		return this.is_parse_error;
	}

	private async parse_urlencoded(): Promise<boolean>
	{	const S_NAME = 0;
		const S_VALUE = 1;

		let buffer = new Uint8Array(BUFFER_LEN); // buffer for read data
		let buffer_start = 0; // data in use is buffer[buffer_start .. buffer_end]
		let buffer_end = 0;
		let name = ''; // param name read from stream (after '&' and before '='); is valid in S_VALUE
		let state = S_NAME; // parser state
		let is_eof = false;
		let ignored_some_param = false;

L:		while (true)
		{	// 1. Set "i" to index of EQ or AMP or to buffer_end in case of EOF
			let i = buffer_start;
			while (true)
			{	i = state==S_NAME ? buffer_index_of_one_of_2(buffer, i, buffer_end, EQ, AMP) : buffer.subarray(0, buffer_end).indexOf(AMP, i);
				if (i != -1)
				{	break;
				}
				// not enough data in buffer
				if (buffer_end-buffer_start > (state==S_NAME ? this.maxNameLength : this.maxValueLength))
				{	// ignore extremely long parameter
					ignored_some_param = true;
					while (true)
					{	let n_read = await this.reader.read(buffer);
						if (n_read == null)
						{	break L;
						}
						i = buffer.indexOf(AMP);
						if (i != -1)
						{	buffer_start = i + 1; // after '&'
							buffer_end = n_read - buffer_start;
							continue L;
						}
					}
				}
				if (buffer_end+REALLOC_THRESHOLD > buffer.length)
				{	// too few space in buffer
					if (buffer_start != 0)
					{	buffer.copyWithin(0, buffer_start, buffer_end); // TODO: second arg, postcorrect
						buffer_end -= buffer_start;
						buffer_start = 0;
					}
					else
					{	// realloc
						let tmp = new Uint8Array(buffer.length*2);
						tmp.set(buffer.subarray(0, buffer_end));
						buffer = tmp;
					}
				}
				i = buffer_end;
				let n_read = await this.reader.read(buffer.subarray(buffer_end));
				if (n_read == null)
				{	is_eof = true;
					break;
				}
				buffer_end += n_read;
			}

			// 2. Read param name (if S_NAME) or value (if S_VALUE)
			let str = this.decoder.decode(buffer.subarray(buffer_start, i));
			buffer_start = i + 1; // after '=' or '&'
			if (buffer[i] == EQ)
			{	assert(state == S_NAME); // i didn't look for EQ in S_VALUE state
				name = str;
				state = S_VALUE;
			}
			else
			{	if (state == S_NAME)
				{	// case: name (without '=')
					this.setStructured(str, '');
				}
				else
				{	// case: name=value
					this.setStructured(name, str);
					state = S_NAME;
				}
				if (is_eof)
				{	break;
				}
			}
		}

		return !ignored_some_param;
	}

	/// According to: https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html
	private async parse_mulpipart_form_data(): Promise<boolean>
	{	/*	Parse:

			------------------------------b2449e94a11c
			Content-Disposition: form-data; name="user_id"

			3
			------------------------------b2449e94a11c
			Content-Disposition: form-data; name="post_id"

			5
			------------------------------b2449e94a11c
			Content-Disposition: form-data; name="image"; filename="/tmp/current_file"
			Content-Type: application/octet-stream

			...
			...
		*/

		const S_HEADER = 0;
		const S_HEADER_VALUE = 1;

		let buffer = new Uint8Array(BUFFER_LEN); // buffer for read data
		let buffer_start = 0; // data in use is buffer[buffer_start .. buffer_end]
		let buffer_end = 0;
		let read_content_length = 0; // how many bytes passed to read()
		let header_name = ''; // is valid in S_HEADER_VALUE
		let name = ''; // is valid in S_BODY
		let filename = ''; // is valid in S_BODY
		let content_type = ''; // is valid in S_BODY
		let state = S_HEADER; // parser state
		let boundary = new TextEncoder().encode(this.formDataBoundary);
		let ignored_some_param = false;

		if (boundary.length==0 || boundary.length+2>MAX_BOUNDARY_LEN)
		{	return false;
		}

		// Skip anything before first boundary (it must be ignored according to RFC)
		while (true)
		{	let n_read = await this.reader.read(buffer);
			if (n_read == null)
			{	return false;
			}
			buffer_end = n_read;
			read_content_length += n_read;
			// look for "boundary" followed by "\r\n"
			let i = buffer_index_of_nl(buffer, buffer_end, boundary);
			if (i != -1)
			{	// found first boundary followed by "\r\n"
				buffer_start = i + boundary.length + 2;
				break;
			}
			i = boundary.length + (2 - 1); // + "\r\n".length - 1
			buffer.copyWithin(0, buffer_end-i, buffer_end);
			buffer_end = i;
		}

		while (true)
		{	// 1. Set "i" to index of COLON, CR or LF, depending on "state"
			let i = buffer_start;
			while (true)
			{	i = state==S_HEADER ? buffer_index_of_one_of_3(buffer, i, buffer_end, COLON, CR, LF) : buffer.subarray(0, buffer_end).indexOf(CR, i);
				if (i != -1)
				{	break;
				}
				// not enough data in buffer
				if (buffer_end+REALLOC_THRESHOLD > buffer.length)
				{	// too few space in buffer
					if (buffer_start == 0)
					{	return false; // header is too long
					}
					buffer.copyWithin(0, buffer_start, buffer_end);
					buffer_end -= buffer_start;
					buffer_start = 0;
				}
				i = buffer_end;
				let n_read = await this.reader.read(buffer.subarray(buffer_end));
				if (n_read == null)
				{	return false; // incomplete header
				}
				buffer_end += n_read;
				read_content_length += n_read;
			}

			// 2. Read header
			if (state == S_HEADER)
			{	if (i != buffer_start)
				{	// header
					if (buffer[i] != COLON)
					{	return false; // header name is too long, or no header name
					}
					header_name = this.decoder.decode(buffer.subarray(buffer_start, i)).trim().toLowerCase();
					buffer_start = i + 1; // after ':'
					state = S_HEADER_VALUE;
				}
				else
				{	// empty line terminates headers
					if (buffer[i] != CR)
					{	return false; // line starts with ":" or "\n"
					}
					buffer_start += 2; // after "\r\n"
					if (buffer_start != buffer_end)
					{	// read body
						i = buffer_start;
						let is_eof = false;
						if (filename)
						{	// is uploaded file
							let tmp_name = await Deno.makeTempFile();
							let fh: Deno.File | undefined = await Deno.open(tmp_name, {read: true, write: true});
							let size = 0;
							while (true)
							{	let i2;
								if (!is_eof)
								{	i = buffer_index_of(buffer, buffer_start, buffer_end, boundary);
									if (i != -1)
									{	i2 = buffer.subarray(0, i).lastIndexOf(13, i);
										if (i2 == -1)
										{	return false; // no "\r\n" after value and before boundary
										}
									}
									else
									{	i2 = Math.max(buffer_start, buffer_end - boundary.length + 1);
									}
								}
								else
								{	i2 = buffer_end;
									i = buffer_end;
								}
								size += i2 - buffer_start;
								if (fh)
								{	try
									{	if (size > this.maxFileSize)
										{	throw new Error('Uploaded file is too large');
										}
										await Deno.writeAll(fh, buffer.subarray(buffer_start, i2));
									}
									catch (e)
									{	// maybe disk full
										console.error(e);
										ignored_some_param = true;
										fh.close();
										fh = undefined;
										try
										{	await Deno.truncate(tmp_name);
											await Deno.remove(tmp_name);
										}
										catch (e2)
										{	console.error(e2);
										}
									}
								}
								if (i != -1)
								{	break;
								}
								buffer.copyWithin(0, i2, buffer_end);
								buffer_start = 0;
								buffer_end -= i2;
								let n_read = await this.reader.read(buffer.subarray(buffer_end));
								if (n_read != null)
								{	buffer_end += n_read;
									read_content_length += n_read;
								}
								else
								{	// this was the last value
									is_eof = true;
								}
							}
							// value complete (at boundary or at EOF)
							if (fh)
							{	fh.close();
							}
							this.uploaded_files.push(tmp_name);
							this.files.set
							(	name,
								new UploadedFile(filename, content_type ?? 'text/plain', size, fh ? tmp_name : '', fh ? UPLOAD_ERR_OK : UPLOAD_ERR_CANT_WRITE)
							);
						}
						else
						{	// is regular field
							// Set "i" to index of boundary, or to buffer_end in case of EOF
							i = buffer_start;
							let is_ignored = false;
							while (true)
							{	i = buffer_index_of(buffer, i, buffer_end, boundary);
								if (i != -1)
								{	break;
								}
								// not enough data in buffer
								if (buffer_end-buffer_start > this.maxValueLength+boundary.length-1)
								{	// ignore extremely long value
									is_ignored = true;
									ignored_some_param = true;
								}
								if (buffer_end+REALLOC_THRESHOLD > buffer.length)
								{	// too few space in buffer
									if (is_ignored)
									{	buffer_start = 0;
										buffer_end = 0;
									}
									else if (buffer_start != 0)
									{	buffer.copyWithin(0, buffer_start, buffer_end);
										buffer_end -= buffer_start;
										buffer_start = 0;
									}
									else
									{	// realloc
										let tmp = new Uint8Array(buffer.length*2);
										tmp.set(buffer.subarray(0, buffer_end));
										buffer = tmp;
									}
								}
								let n_read = await this.reader.read(buffer.subarray(buffer_end));
								if (n_read != null)
								{	i = Math.max(buffer_start, buffer_end - boundary.length + 1);
									buffer_end += n_read;
									read_content_length += n_read;
								}
								else
								{	// this was the last value
									i = buffer_end;
									is_eof = true;
									break;
								}
							}
							if (!is_ignored)
							{	let i2 = buffer.subarray(0, i).lastIndexOf(13, i);
								if (i2 == -1)
								{	return false; // no "\r\n" after value and before boundary
								}
								this.setStructured(name, this.decoder.decode(buffer.subarray(buffer_start, i2)));
							}
						}
						if (is_eof)
						{	// According to FastCGI specification, FastCGI server can send partial body, and client must validate against CONTENT_LENGTH
							if (this.contentLength>0 && read_content_length!=this.contentLength)
							{	return false;
							}
							return !ignored_some_param; // is at EOF
						}
						buffer_start = i + boundary.length + 2; // boundary.length + "\r\n".length; or: boundary.length + "--".length
						assert(state == S_HEADER);
						name = '';
						content_type = '';
						filename = '';
					}
				}
			}
			else
			{	if (header_name == 'content-disposition')
				{	let i2 = buffer.subarray(0, i).indexOf(SEMICOLON, buffer_start);
					if (i2 == -1)
					{	return false; // no ';' in "Content-Disposition: form-data; ..."
					}
					i2++; // after ';'
					let line = this.decoder.decode(buffer.subarray(i2, i));
					RE_HEADER_VALUE.lastIndex = 0;
					let m;
					while ((m = RE_HEADER_VALUE.exec(line)))
					{	let field = m[1].toLowerCase();
						if (field == 'name')
						{	name = decodeURIComponent(m[2]);
						}
						else if (field == 'filename')
						{	filename = decodeURIComponent(m[2]);
						}
					}
				}
				else if (header_name == 'content-type')
				{	content_type = this.decoder.decode(buffer.subarray(buffer_start, i)).trim();
				}
				buffer_start = i + 2; // after "\r\n"
				header_name = '';
				state = S_HEADER;
			}
		}
	}
}

function buffer_index_of(haystack: Uint8Array, haystack_start: number, haystack_end: number, needle: Uint8Array)
{	// run through all bytes
	let needle_end = needle.length;
L:	for (let i_end=haystack_end-needle_end; haystack_start<=i_end; haystack_start++)
	{	for (let j=haystack_start, k=0; k<needle_end; k++)
		{	if (haystack[j++] != needle[k])
			{	continue L;
			}
		}
		return haystack_start;
	}
	return -1;
}

function buffer_index_of_nl(haystack: Uint8Array, haystack_len: number, needle: Uint8Array)
{	// run through all bytes
	let needle_end = needle.length;
L:	for (let i=0, i_end=haystack_len-needle_end; i<=i_end; i++)
	{	if (haystack[i+needle_end]!=13 || haystack[i+needle_end+1]!=10)
		{	continue;
		}
		for (let j=i, k=0; k<needle_end; k++)
		{	if (haystack[j++] != needle[k])
			{	continue L;
			}
		}
		return i;
	}
	return -1;
}

function buffer_index_of_one_of_2(buffer: Uint8Array, start: number, end: number, b0: number, b1: number)
{	// run through all bytes
	while (start < end)
	{	let c = buffer[start];
		if (c==b0 || c==b1)
		{	return start;
		}
		start++;
	}
	return -1;
}

function buffer_index_of_one_of_3(buffer: Uint8Array, start: number, end: number, b0: number, b1: number, b2: number)
{	// run through all bytes
	while (start < end)
	{	let c = buffer[start];
		if (c==b0 || c==b1 || c==b2)
		{	return start;
		}
		start++;
	}
	return -1;
}
