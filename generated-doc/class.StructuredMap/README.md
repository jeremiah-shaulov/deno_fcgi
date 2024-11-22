# `class` StructuredMap `extends` Map\<`string`, [PathNode](../type.PathNode/README.md)>

[Documentation Index](../README.md)

Extends `Map` and provides `setStructured()` method.

## This class has

- [constructor](#-constructorstructuredparams-booleantrue)
- property [structuredParams](#-structuredparams-boolean)
- method [setStructured](#-setstructuredname-string-value-string-boolean)
- base class


#### 🔧 `constructor`(structuredParams: `boolean`=true)



#### 📄 structuredParams: `boolean`



#### ⚙ setStructured(name: `string`, value: `string`): `boolean`

> If key is like "items[]=a&items[]=b" or "items[a][b]=c", follows the path, creating additional `Map<string, PathNode>` objects.
> The algorithm is similar to how PHP parses GET parameters.



