const BUFFER_LEN = 4*1024;
const MAX_BOUNDARY_LEN = 100;

const UPLOAD_ERR_OK = 0;
const UPLOAD_ERR_CANT_WRITE = 7;

const AMP = '&'.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const SEMICOLON = ';'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);

const CRLF = new Uint8Array([CR, LF]);

const RE_HEADER_VALUE = /\s*(\w+)="([^"]+)"(?:;|$)/g;

export class UploadedFile
{	constructor(public name='', public type='', public size=0, public tmpName='', public error=0)
	{
	}
}

export class Post extends Map<string, any>
{	/// Post body "Content-Type". Lowercased, and part starting with ';' is cut (if any)
	public contentType = '';
	/// If contentType is 'multipart/form-data', this will be data boundary.
	public formDataBoundary = '';
	/// the "Content-Length" HTTP header
	public contentLength = -1;
	/// Was parse() called?
	public isParsed = false;
	/// Uploaded files are stored to temporary files that will be deleted at the end of request. You can read them, or move to a different location (from where they will not be deleted).
	public files = new Map<string, UploadedFile>();
	/// Parse params like "items[]=a&items[]=b" to arrays, like PHP does. And params like "items[a]=b" to objects.
	public withStructure = false;

	private is_parse_error = false;
	private uploaded_files: string[] = [];

	constructor
	(	private reader: Deno.Reader,
		/// What decoder to use to decode bytes of the post data (not for uploaded files - they are written binary as is)
		public decoder = new TextDecoder
	)
	{	super();
	}

	close()
	{	for (let f of this.uploaded_files)
		{	Deno.remove(f).catch(e => console.error(e));
		}
		this.uploaded_files.length = 0;
	}

	/// Reads POST body, and tries to parse it according to `contentType`.
	/// The following content types are supported: 'application/x-www-form-urlencoded', 'multipart/form-data'.
	async parse()
	{	if (!this.isParsed)
		{	this.isParsed = true;
			if (this.contentType == 'application/x-www-form-urlencoded')
			{	// Decode application/x-www-form-urlencoded
				let data = await Deno.readAll(this.reader); // TODO: ...
				let i = 0;
				while (i < data.length)
				{	let i_end = data.indexOf(AMP);
					if (i_end == -1)
					{	i_end = data.length;
					}
					let eq = data.indexOf(EQ, i);
					let name;
					let value = '';
					if (eq < i_end)
					{	name = decodeURIComponent(this.decoder.decode(data.subarray(i, eq)));
						value = decodeURIComponent(this.decoder.decode(data.subarray(eq+1, i_end)));
					}
					else
					{	name = decodeURIComponent(this.decoder.decode(data.subarray(i, i_end)));
					}
					this.set_field(name, value);
					i = i_end + 1;
				}
			}
			else if (this.contentType == 'multipart/form-data')
			{	// Decode multipart/form-data
				this.is_parse_error = await this.parse_mulpipart_form_data();
			}
		}
		return this.is_parse_error;
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

		const S_INITIAL = 0;
		const S_HEADER = 1;
		const S_HEADER_VALUE = 2;
		const S_BODY = 3;
		const S_DONE = 4;

		let data = new Uint8Array(BUFFER_LEN); // buffer for read data
		let data_len = 0; // data in use is data[0 .. data_len]
		let read_content_length = 0; // how many bytes passed to read()
		let header_name = ''; // is valid in S_HEADER_VALUE
		let name = ''; // is valid in S_BODY
		let filename = ''; // is valid in S_BODY
		let content_type = ''; // is valid in S_BODY
		let tmp_name = ''; // is valid in S_BODY
		let value = new Uint8Array(0); // is used in S_BODY
		let value_len = 0;
		let value_fh: Deno.File | undefined; // is used in S_BODY
		let state: number = S_INITIAL; // parser state
		let boundary = new TextEncoder().encode(this.formDataBoundary);
		let boundary_endl = new Uint8Array(boundary.length + 2);

		boundary_endl.set(boundary);
		boundary_endl[boundary_endl.length-2] = 13; // \r
		boundary_endl[boundary_endl.length-1] = 10; // \n

		while (true)
		{	if (data_len == BUFFER_LEN)
			{	return false; // error
			}
			let n_read = await this.reader.read(data.subarray(data_len));
			let is_eof = n_read == null;
			if (n_read != null)
			{	data_len += n_read;
				read_content_length += n_read;
			}
			let i = 0;
			let i2;
L:			while (i < data_len)
			{	switch (state)
				{	case S_DONE:
						// According to FastCGI specification, FastCGI server can send partial body, and client must validate against CONTENT_LENGTH
						if (this.contentLength>0 && read_content_length!=this.contentLength)
						{	return false;
						}
						return true;

					case S_INITIAL:
						i = buffer_index_of(data, data_len, boundary_endl); // skip anything before first boundary (it must be ignored according to RFC)
						if (i == -1)
						{	if (is_eof)
							{	return false; // no first line
							}
							i = data_len - MAX_BOUNDARY_LEN;
							break L;
						}
						i += boundary.length + 2;
						state = S_HEADER;
						// fallthrough

					case S_HEADER:
						i2 = buffer_index_of_one_of(data, i, data_len, COLON, CR, LF);
						if (i2 == -1)
						{	break L;
						}
						if (i2 == i)
						{	// empty line terminates headers
							if (data[i] != CR)
							{	return false; // line starts with ":" or "\n"
							}
							i += 2; // after "\r\n"
							if (filename)
							{	tmp_name = await Deno.makeTempFile();
								value_fh = await Deno.open(tmp_name, {read: true, write: true});
							}
							state = S_BODY;
							break;
						}
						else
						{	// header
							if (i2-i>256 || data[i2]!=COLON)
							{	return false; // header name is too long, or no header name
							}
							header_name = this.decoder.decode(data.subarray(i, i2)).trim();
							i = i2 + 1; // after ':'
							state = S_HEADER_VALUE;
							// fallthrough
						}

					case S_HEADER_VALUE:
						i2 = data.indexOf(CR, i); // at "\r"
						if (i2 == -1)
						{	break L;
						}
						if (header_name.toLowerCase() == 'content-disposition')
						{	let i3 = data.indexOf(SEMICOLON, i);
							if (i3==-1 || i3>i2)
							{	return false; // no ';' in "Content-Disposition: form-data; ..."
							}
							i3++; // after ';'
							let line = this.decoder.decode(data.subarray(i3, i2));
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
						else if (header_name.toLowerCase() == 'content-type')
						{	content_type = this.decoder.decode(data.subarray(i, i2)).trim();
						}
						i = i2 + 2; // after "\r\n"
						header_name = '';
						state = S_HEADER;
						break;

					case S_BODY:
						if (value_len+data_len-i > value.length)
						{	// realloc
							let tmp = new Uint8Array(Math.max(value.length*2, value_len+data_len-i));
							tmp.set(value.subarray(0, value_len));
							value = tmp;
						}
						value.set(data.subarray(i, data_len), value_len);
						value_len += data_len-i;
						i = data_len;
						i2 = buffer_index_of(value, value_len, boundary);
						if (i2 == -1)
						{	if (is_eof)
							{	data_len = 0;
								state = S_DONE;
							}
						}
						else
						{	i -= value_len - i2;
							value_len = i2;
							let i3 = buffer_index_of(value, value_len, CRLF);
							if (i3 == -1)
							{	data_len = 0;
								return false; // boundary is not on it's own line
							}
							value_len = i3;
							i += boundary.length + 2; // boundary.length + strlen("\r\n"); or: boundary.length + strlen("--")
							state = S_HEADER;
						}
						if (state != S_BODY)
						{	if (!filename)
							{	// is regular field
								this.set_field(name, this.decoder.decode(value.subarray(0, value_len)));
							}
							else
							{	// is file
								let len = 0;
								if (await write(value.subarray(0, value_len)))
								{	len = await value_fh!.seek(0, Deno.SeekMode.Current);
									value_fh!.close();
									this.uploaded_files.push(tmp_name);
								}
								this.files.set
								(	name,
									new UploadedFile(filename, content_type ?? 'text/plain', len, value_fh==undefined ? '' : tmp_name, value_fh==undefined ? UPLOAD_ERR_CANT_WRITE : UPLOAD_ERR_OK)
								);
								tmp_name = '';
								filename = '';
								value_fh = undefined;
							}
							name = '';
							content_type = '';
							value_len = 0;
						}
						else if (filename)
						{	// is file
							if (value_len > MAX_BOUNDARY_LEN) // always leave MAX_BOUNDARY_LEN chars in buffer, assuming the boundary line (with filler chars) is shorter, so i can find whole boundary
							{	await write(value.subarray(0, value_len-MAX_BOUNDARY_LEN));
								value.copyWithin(0, value_len-MAX_BOUNDARY_LEN, value_len);
								value_len = MAX_BOUNDARY_LEN;
							}
						}
						break;
				}
			}
			if (i == 0)
			{	return false;
			}
			data.copyWithin(0, i);
			data_len -= i;
		}

		async function write(value: Uint8Array)
		{	if (value_fh != undefined)
			{	try
				{	await Deno.writeAll(value_fh, value);
					return true;
				}
				catch (e)
				{	// maybe disk full
					console.error(e);
					value_fh.close();
					try
					{	await Deno.truncate(tmp_name);
						await Deno.remove(tmp_name);
					}
					catch (e2)
					{	console.error(e2);
					}
					value_fh = undefined;
				}
			}
			return false;
		}
	}

	private set_field(name: string, value: string|UploadedFile)
	{	super.set(name, value); // TODO: withStructure
	}
}

function buffer_index_of(haystack: Uint8Array, haystack_len: number, needle: Uint8Array)
{	// run through all bytes
L:	for (let i=0, i_end=haystack_len-needle.length; i<=i_end; i++)
	{	for (let j=i, k=0, k_end=needle.length; k<k_end; k++)
		{	if (haystack[j++] != needle[k])
			{	continue L;
			}
		}
		return i;
	}
	return -1;
}

function buffer_index_of_one_of(buffer: Uint8Array, start: number, end: number, b0: number, b1: number, b2: number)
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
