import assert from 'node:assert/strict';

import {
  canonicalJsonSha256,
  isRedistributableLicense,
  normalizedLicenseUrl,
  plainText,
} from './library-image-common.mjs';

assert.equal(plainText('<a href="/wiki/User:Example">Jane &amp; John</a>'), 'Jane & John');
assert.equal(
  normalizedLicenseUrl('Public domain', undefined),
  'https://creativecommons.org/publicdomain/mark/1.0/',
);
assert.equal(
  normalizedLicenseUrl('CC BY-SA 4.0', 'http://creativecommons.org/licenses/by-sa/4.0'),
  'https://creativecommons.org/licenses/by-sa/4.0/',
);
assert.equal(
  isRedistributableLicense(
    'CC BY-SA 4.0',
    'https://creativecommons.org/licenses/by-sa/4.0/',
  ),
  true,
);
assert.equal(
  isRedistributableLicense(
    'CC BY 2.5 au',
    'https://creativecommons.org/licenses/by/2.5/au/',
  ),
  true,
);
assert.equal(
  isRedistributableLicense('GFDL', 'https://www.gnu.org/licenses/fdl-1.3.html'),
  false,
);
assert.equal(canonicalJsonSha256([{ id: 'a' }]), canonicalJsonSha256([{ id: 'a' }]));

console.log('Library image tooling tests passed.');
