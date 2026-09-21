import os, sys, json, base64, struct, zlib, requests
sys.path.insert(0, 'C:/Users/tanmo/Projects/MicrostockMetadata')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django
django.setup()

from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session

for s in Session.objects.all():
    ss = SessionStore(session_key=s.session_key)
    keys = ss.get('gemini_api_keys', [])
    if keys:
        session_key = s.session_key
        break

print('Session:', session_key[:10] + '...')

sig = b'\x89PNG\r\n\x1a\n'
ihdr_data = struct.pack('>IIBBBBB', 10, 10, 8, 2, 0, 0, 0)
ihdr_chunk = b'IHDR' + ihdr_data
ihdr_crc = struct.pack('>I', zlib.crc32(ihdr_chunk) & 0xffffffff)
ihdr_full = struct.pack('>I', len(ihdr_data)) + ihdr_chunk + ihdr_crc
raw = b''
for y in range(10):
    raw += b'\x00' + b'\xff\x00\x00' * 10
compressed = zlib.compress(raw)
idat_chunk = b'IDAT' + compressed
idat_crc = struct.pack('>I', zlib.crc32(idat_chunk) & 0xffffffff)
idat_full = struct.pack('>I', len(compressed)) + idat_chunk + idat_crc
iend = b'IEND'
iend_crc = struct.pack('>I', zlib.crc32(iend) & 0xffffffff)
iend_full = struct.pack('>I', 0) + iend + iend_crc
png_b64 = base64.b64encode(sig + ihdr_full + idat_full + iend_full).decode()

url = 'http://127.0.0.1:8000/api/analyze-metadata/'
payload = {
    'image': png_b64,
    'mimeType': 'image/png',
    'fileName': 'test-red.png',
    'fileType': 'image/png',
    'platform': 'adobe-stock',
    'settings': {},
    'fileHash': 'test123',
    'model': 'gemini-3.6-flash',
}

cookies = {'sessionid': session_key}
print('Sending POST to', url)
print('Image data size:', len(png_b64), 'chars')

try:
    r = requests.post(url, json=payload, cookies=cookies, timeout=120)
    print('Status:', r.status_code)
    data = r.json()
    if 'metadata' in data:
        meta = data['metadata']
        print('Title:', meta.get('title', 'N/A')[:80])
        print('Keywords:', len(meta.get('keywords', [])))
        print('END-TO-END PASS')
    elif 'error' in data:
        print('Error:', data.get('error', 'unknown'))
        print('Details:', data.get('technicalDetails', 'none')[:200])
    else:
        print('Response keys:', list(data.keys()))
except Exception as e:
    print('ERROR:', e)
