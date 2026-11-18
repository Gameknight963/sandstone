import { known_urls } from "../network.mjs";
import {create_url_constructor} from '../url.mjs';

export const FakeURL=create_url_constructor(globalThis.URL,url=>known_urls[url]??url);
