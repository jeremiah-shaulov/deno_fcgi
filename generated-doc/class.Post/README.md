# `class` Post `extends` [StructuredMap](../class.StructuredMap/README.md)

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorreader-reader-onerror-error-error--void-contenttype-string-formdataboundary-string-contentlength-number1-structuredparams-booleanfalse-maxnamelength-number256-maxvaluelength-number101024-maxfilesize-number1010241024-decoder-textdecodernew-textdecoder)
- 10 properties:
[isParsed](#-isparsed-boolean),
[files](#-files-mapstring-uploadedfile),
[contentType](#-contenttype-string),
[formDataBoundary](#-formdataboundary-string),
[contentLength](#-contentlength-number),
[structuredParams](#-structuredparams-boolean),
[maxNameLength](#-maxnamelength-number),
[maxValueLength](#-maxvaluelength-number),
[maxFileSize](#-maxfilesize-number),
[decoder](#-decoder-textdecoder)
- 2 methods:
[close](#-close-promiseany),
[parse](#-parse-promiseboolean)
- base class


#### 🔧 `constructor`(reader: [Reader](../interface.Reader/README.md), onerror: (error: Error) => `void`, contentType: `string`="", formDataBoundary: `string`="", contentLength: `number`=-1, structuredParams: `boolean`=false, maxNameLength: `number`=256, maxValueLength: `number`=10\*1024, maxFileSize: `number`=10\*1024\*1024, decoder: TextDecoder=new TextDecoder)



#### 📄 isParsed: `boolean`



#### 📄 files: Map\<`string`, [UploadedFile](../class.UploadedFile/README.md)>



#### 📄 contentType: `string`

> Post body "Content-Type". Lowercased, and part starting with ';' is cut (if any)



#### 📄 formDataBoundary: `string`

> If contentType is 'multipart/form-data', this will be data boundary.



#### 📄 contentLength: `number`

> the "Content-Length" HTTP header



#### 📄 structuredParams: `boolean`

> Parse params like "items[]=a&items[]=b" and "items[a][b]=c" to Map objects, like PHP does.



#### 📄 maxNameLength: `number`

> Parameters with longer names will be ignored.



#### 📄 maxValueLength: `number`

> Parameters with longer values will be ignored.



#### 📄 maxFileSize: `number`

> Uploaded files bigger than this will be ignored.



#### 📄 decoder: TextDecoder

> What decoder to use to decode bytes of the post data (not for uploaded files - they are written binary as is)



#### ⚙ close(): Promise\<`any`\[]>



#### ⚙ parse(): Promise\<`boolean`>

> Reads POST body, and tries to parse it according to `contentType`.
> The following content types are supported: `application/x-www-form-urlencoded`, `multipart/form-data`.
> The object is empty before this method called. It can be called many times (next calls do nothing).
> `isParsed` is set regardless of errors.
> 
> ✔️ Return value:
> 
> Returns true if parsed successfully, and false if invalid format, or some name/value was too long. On I/O errors throws exception.



