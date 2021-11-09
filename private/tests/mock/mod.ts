export {MockConn} from './private/mock_conn.ts';
export {MockFcgiConn} from './private/mock_fcgi_conn.ts';
export {MockListener} from './private/mock_listener.ts';
export {get_random_bytes, get_random_string, map_to_obj} from './private/util.ts';

export const TEST_CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 20, 25, 30, 33, 44, 55, 80, 81, 91, 100, 110, 123, 150, 201, 300, 400, 500, 1000, 10_000, 100_000, 0x7FFF_FFFF];
//export const TEST_CHUNK_SIZES = [8];
