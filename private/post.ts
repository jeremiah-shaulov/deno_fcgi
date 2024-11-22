import {debug_assert} from './debug_assert.ts';
import {StructuredMap} from './structured_map.ts';
import {writeAll} from './util.ts';
import {Reader} from './deno_ifaces.ts';

const BUFFER_LEN = 8*1024;
export const REALLOC_THRESHOLD = 512; // max length for header line like `Content-Disposition: form-data; name="image"; filename="/tmp/current_file"` is BUFFER_LEN-REALLOC_THRESHOLD
const MAX_BOUNDARY_LEN = 100;
const MAX_BOUNDARY_PAD_CHARS = 16; // boundary '--Bnd' can be padded with more dashes, like '----Bnd'

const UPLOAD_ERR_OK = 0;
const UPLOAD_ERR_CANT_WRITE = 7;

const AMP = '&'.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const SEMICOLON = ';'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const QT = '"'.charCodeAt(0);
const BACKSLASH = '\\'.charCodeAt(0);

debug_assert(MAX_BOUNDARY_LEN+2 <= BUFFER_LEN); // (boundary + "\r\n").length

const encoder = new TextEncoder;

export class UploadedFile
{	constructor(public name='', public type='', public size=0, public tmpName='', public error=0)
	{
	}
}

export class Post extends StructuredMap
{	/// Was parse() called?
	isParsed = false;
	/// Uploaded files are stored to temporary files that will be deleted at the end of request. You can read them, or move to a different location (from where they will not be deleted).
	files = new Map<string, UploadedFile>();

	private is_parse_success = false;
	private uploaded_files = new Array<string>;

	constructor
	(	private reader: Reader,
		private onerror: (error: Error) => void,
		/** Post body "Content-Type". Lowercased, and part starting with ';' is cut (if any) */
		public contentType = '',
		/** If contentType is 'multipart/form-data', this will be data boundary. */
		public formDataBoundary = '',
		/** the "Content-Length" HTTP header */
		public contentLength = -1,
		/** Parse params like "items[]=a&items[]=b" and "items[a][b]=c" to Map objects, like PHP does. */
		public override structuredParams = false,
		/** Parameters with longer names will be ignored. */
		public maxNameLength = 256,
		/** Parameters with longer values will be ignored. */
		public maxValueLength = 10*1024,
		/** Uploaded files bigger than this will be ignored. */
		public maxFileSize = 10*1024*1024,
		/** What decoder to use to decode bytes of the post data (not for uploaded files - they are written binary as is) */
		public decoder = new TextDecoder
	)
	{	super(structuredParams);
	}

	close()
	{	const promises = [];
		for (const f of this.uploaded_files)
		{	promises[promises.length] = Deno.remove(f).catch
			(	e =>
				{	if (e.name != 'NotFound')
					{	this.onerror(e);
					}
				}
			);
		}
		this.uploaded_files.length = 0;
		return Promise.all(promises);
	}

	/**	Reads POST body, and tries to parse it according to `contentType`.
		The following content types are supported: `application/x-www-form-urlencoded`, `multipart/form-data`.
		The object is empty before this method called. It can be called many times (next calls do nothing).
		`isParsed` is set regardless of errors.

		@returns Returns true if parsed successfully, and false if invalid format, or some name/value was too long. On I/O errors throws exception.
	 **/
	async parse()
	{	if (!this.isParsed)
		{	this.isParsed = true;
			if (this.contentType == 'application/x-www-form-urlencoded')
			{	this.is_parse_success = await this.parse_urlencoded();
			}
			else if (this.contentType == 'multipart/form-data')
			{	this.is_parse_success = await this.parse_mulpipart_form_data();
			}
		}
		return this.is_parse_success;
	}

	private async parse_urlencoded(): Promise<boolean>
	{	const S_NAME = 0;
		const S_VALUE = 1;

		let {reader, decoder, maxNameLength, maxValueLength} = this;
		maxNameLength |= 0;
		maxValueLength |= 0;

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
				if (buffer_end-buffer_start > (state==S_NAME ? maxNameLength : maxValueLength))
				{	// ignore extremely long parameter
					ignored_some_param = true;
					while (true)
					{	const n_read = await reader.read(buffer);
						if (n_read == null)
						{	break L;
						}
						i = buffer.subarray(0, n_read).indexOf(AMP);
						if (i != -1)
						{	buffer_start = i + 1; // after '&'
							buffer_end = n_read;
							state = S_NAME;
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
						const tmp = new Uint8Array(buffer.length*2);
						tmp.set(buffer.subarray(0, buffer_end));
						buffer = tmp;
					}
				}
				i = buffer_end;
				const n_read = await reader.read(buffer.subarray(buffer_end));
				if (n_read == null)
				{	is_eof = true;
					break;
				}
				buffer_end += n_read;
			}

			// 2. Read param name (if S_NAME) or value (if S_VALUE)
			const str = decodeURIComponent(decoder.decode(buffer.subarray(buffer_start, i)));
			buffer_start = i + 1; // after '=' or '&'
			if (i<buffer_end && buffer[i]===EQ)
			{	debug_assert(state == S_NAME); // i didn't look for EQ in S_VALUE state
				name = str;
				state = S_VALUE;
			}
			else
			{	if (state == S_NAME)
				{	// case: name (without '=')
					if (str.length <= maxNameLength)
					{	if (!this.setStructured(str, ''))
						{	ignored_some_param = true;
						}
					}
				}
				else
				{	// case: name=value
					if (name.length<=maxNameLength && str.length<=maxValueLength)
					{	if (!this.setStructured(name, str))
						{	ignored_some_param = true;
						}
					}
					else
					{	ignored_some_param = true;
					}
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

		let {reader, decoder, uploaded_files, files, maxNameLength, maxValueLength, maxFileSize, contentLength} = this;
		maxNameLength |= 0;
		maxValueLength |= 0;
		maxFileSize |= 0;
		contentLength |= 0;

		let buffer = new Uint8Array(BUFFER_LEN); // buffer for read data
		let buffer_start = 0; // data in use is buffer[buffer_start .. buffer_end]
		let buffer_end = 0;
		let read_content_length = 0; // how many bytes passed to read()
		let header_name = ''; // is valid in S_HEADER_VALUE
		let name = ''; // param name
		let filename = ''; // param filename (uploaded file)
		let content_type = ''; // uploaded file type
		let state = S_HEADER; // parser state
		const boundary = encoder.encode(this.formDataBoundary);
		let ignored_some_param = false;

		if (boundary.length==0 || boundary.length>MAX_BOUNDARY_LEN)
		{	return false;
		}

		// Skip anything before first boundary (it must be ignored according to RFC)
		while (true)
		{	const n_read = await reader.read(buffer.subarray(buffer_end));
			if (n_read == null)
			{	return false;
			}
			buffer_end += n_read;
			read_content_length += n_read;
			// look for "boundary" followed by "\r\n"
			let i = buffer_index_of_nl(buffer, buffer_end, boundary);
			if (i != -1)
			{	// found first boundary followed by "\r\n"
				buffer_start = i + boundary.length + 2;
				break;
			}
			i = buffer_end - boundary.length - ("\r\n".length - 1);
			if (i > 0)
			{	buffer.copyWithin(0, i, buffer_end);
				buffer_end -= i;
			}
		}

		while (true)
		{	//
			if (buffer_start >= buffer_end) // this can happen, because sometimes i blindly skip assumed delimiters
			{	const n_skip = buffer_start - buffer_end;
				buffer_start = n_skip;
				buffer_end = 0;
				while (buffer_end <= n_skip)
				{	const n_read = await reader.read(buffer.subarray(buffer_end));
					if (!n_read)
					{	return false; // incomplete header
					}
					buffer_end += n_read;
					read_content_length += n_read;
				}
			}

			// 1. Set "i" to index of COLON, CR or LF, depending on "state"
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
				const n_read = await reader.read(buffer.subarray(buffer_end));
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
					if (buffer[i] !== COLON)
					{	return false; // header name is too long, or no header name
					}
					header_name = decoder.decode(buffer.subarray(buffer_start, i)).trim().toLowerCase();
					buffer_start = i + 1; // after ':'
					state = S_HEADER_VALUE;
				}
				else
				{	// empty line terminates headers
					if (buffer[i] !== CR)
					{	return false; // line starts with ":" or "\n"
					}
					// at "\r" that hopefully is followed by "\n"
					i++; // to "\n"
					if (i >= buffer_end)
					{	const n_read = await reader.read(buffer);
						if (!n_read)
						{	return false; // no "\n" follows "\r"
						}
						buffer_start = 0;
						buffer_end = n_read;
						read_content_length += n_read;
						i = 0;
					}
					if (buffer[i] !== LF)
					{	return false; // no "\n" follows "\r"
					}
					i++; // after "\r\n"
					buffer_start = i;
					// read body
					let is_eof = false;
					if (name.length > maxNameLength)
					{	name = '';
					}
					if (filename || !name)
					{	// is uploaded file or a value to ignore
						let tmp_name = '';
						let fh: Deno.FsFile | undefined;
						if (name)
						{	// is uploaded file
							tmp_name = await Deno.makeTempFile();
							fh = await Deno.open(tmp_name, {read: true, write: true});
						}
						let size = 0;
						while (true)
						{	let i2;
							if (!is_eof)
							{	i = buffer_index_of(buffer, buffer_start, buffer_end, boundary);
								if (i != -1)
								{	i2 = buffer.subarray(buffer_start, i).lastIndexOf(CR); // actually value terminates "\r\n"+boundary
									if (i2 == -1)
									{	if (fh)
										{	try
											{	fh.close();
												await Deno.remove(tmp_name);
											}
											catch (e)
											{	this.onerror(e instanceof Error ? e : new Error(e+''));
											}
										}
										return false; // no "\r\n" after value and before boundary
									}
									i2 += buffer_start;
								}
								else
								{	i2 = Math.max(buffer_start, buffer_end - boundary.length - (MAX_BOUNDARY_PAD_CHARS - 1));
								}
							}
							else
							{	i2 = buffer_end;
								i = buffer_end;
							}
							size += i2 - buffer_start;
							if (fh && i2-buffer_start>0)
							{	try
								{	if (size > maxFileSize)
									{	throw new Error('Uploaded file is too large');
									}
									await writeAll(fh, buffer.subarray(buffer_start, i2));
								}
								catch (e)
								{	// maybe disk full
									this.onerror(e instanceof Error ? e : new Error(e+''));
									ignored_some_param = true;
									fh.close();
									fh = undefined;
									try
									{	await Deno.truncate(tmp_name);
										await Deno.remove(tmp_name);
									}
									catch (e2)
									{	this.onerror(e2 instanceof Error ? e2 : new Error(e2+''));
									}
									tmp_name = '';
								}
							}
							if (i != -1)
							{	break;
							}
							buffer.copyWithin(0, i2, buffer_end);
							buffer_start = 0;
							buffer_end -= i2;
							const n_read = await reader.read(buffer.subarray(buffer_end));
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
						debug_assert(!fh == !tmp_name);
						if (fh)
						{	debug_assert(name);
							fh.close();
							uploaded_files.push(tmp_name);
						}
						if (name)
						{	files.set
							(	name,
								new UploadedFile(filename, content_type || 'application/octet-stream', size, tmp_name, fh ? UPLOAD_ERR_OK : UPLOAD_ERR_CANT_WRITE)
							);
						}
					}
					else
					{	// is regular field
						// Set "i" to index of boundary, or to buffer_end in case of EOF
						i = buffer_start;
						let is_ignored = !name;
						while (true)
						{	i = buffer_index_of(buffer, i, buffer_end, boundary);
							if (i != -1)
							{	break;
							}
							// not enough data in buffer
							if (buffer_end+REALLOC_THRESHOLD > buffer.length)
							{	if (buffer_end-buffer_start > maxValueLength+boundary.length+MAX_BOUNDARY_PAD_CHARS)
								{	// ignore extremely long value
									is_ignored = true;
									ignored_some_param = true;
								}
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
									const tmp = new Uint8Array(buffer.length*2);
									tmp.set(buffer.subarray(0, buffer_end));
									buffer = tmp;
								}
							}
							const n_read = await reader.read(buffer.subarray(buffer_end));
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
						{	const i2 = buffer.subarray(buffer_start, i).lastIndexOf(CR);
							if (i2 == -1)
							{	return false; // no "\r\n" after value and before boundary
							}
							if (i2 <= maxValueLength)
							{	if (!this.setStructured(name, decoder.decode(buffer.subarray(buffer_start, buffer_start+i2))))
								{	ignored_some_param = true;
								}
							}
						}
					}
					if (is_eof)
					{	// According to FastCGI specification, FastCGI server can send partial body, and client must validate against CONTENT_LENGTH
						if (contentLength>0 && read_content_length!=contentLength)
						{	return false;
						}
						return !ignored_some_param; // is at EOF
					}
					buffer_start = i + boundary.length + 2; // boundary.length + "\r\n".length; or: boundary.length + "--".length
					debug_assert(state == S_HEADER);
					name = '';
					content_type = '';
					filename = '';
				}
			}
			else
			{	if (header_name == 'content-disposition')
				{	let i2 = buffer.subarray(0, i).indexOf(SEMICOLON, buffer_start);
					if (i2 == -1)
					{	return false; // no ';' in "Content-Disposition: form-data; ..."
					}
					// assume: is at string like '; name="main image"; filename="/tmp/current_file"'
					while (true)
					{	while (buffer[++i2] === SPACE); // skip '; '
						let i3 = buffer.subarray(0, i).indexOf(EQ, i2);
						if (i3 == -1)
						{	break;
						}
						const field = decoder.decode(buffer.subarray(i2, i3));
						i2 = i3 + 1; // after '='
						if (buffer[i2] !== QT)
						{	break;
						}
						i2++; // after opening '"'
						i3 = buffer.subarray(0, i).indexOf(QT, i2);
						while (buffer[i3-1] === BACKSLASH)
						{	i3 = buffer.subarray(0, i).indexOf(QT, i3+1);
						}
						if (i3 == -1)
						{	break;
						}
						if (field == 'name')
						{	name = decoder.decode(buffer.subarray(i2, i3)).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
						}
						else if (field == 'filename')
						{	filename = decoder.decode(buffer.subarray(i2, i3)).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
						}
						i2 = i3 + 1; // after closing '"'
					}
				}
				else if (header_name == 'content-type')
				{	content_type = decoder.decode(buffer.subarray(buffer_start, i)).trim();
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
	const needle_end = needle.length;
	if (haystack_end-haystack_start < needle_end)
	{	return -1;
	}
L:	for (const i_end=haystack_end-needle_end; haystack_start<=i_end; haystack_start++)
	{	for (let j=haystack_start, k=0; k<needle_end; k++)
		{	if (haystack[j++] !== needle[k])
			{	continue L;
			}
		}
		return haystack_start;
	}
	return -1;
}

function buffer_index_of_nl(haystack: Uint8Array, haystack_len: number, needle: Uint8Array)
{	// run through all bytes
	const needle_end = needle.length;
L:	for (let i=needle_end, i_end=haystack_len-2; i<=i_end; i++)
	{	if (haystack[i]!==CR || haystack[i+1]!==LF)
		{	continue;
		}
		const at = i - needle_end;
		for (let j=at, k=0; k<needle_end; k++)
		{	if (haystack[j++] !== needle[k])
			{	continue L;
			}
		}
		return at;
	}
	return -1;
}

function buffer_index_of_one_of_2(buffer: Uint8Array, start: number, end: number, b0: number, b1: number)
{	// run through all bytes
	while (start < end)
	{	const c = buffer[start];
		if (c===b0 || c===b1)
		{	return start;
		}
		start++;
	}
	return -1;
}

function buffer_index_of_one_of_3(buffer: Uint8Array, start: number, end: number, b0: number, b1: number, b2: number)
{	// run through all bytes
	while (start < end)
	{	const c = buffer[start];
		if (c===b0 || c===b1 || c===b2)
		{	return start;
		}
		start++;
	}
	return -1;
}
