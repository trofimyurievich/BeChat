"""Read attachments only from the messenger's own HTTPS storage."""
import base64
from urllib.parse import urlsplit
from aiohttp import ClientError, ClientSession, ClientTimeout

MAX_SIZE = 8 * 1024 * 1024
VK_DOMAINS = ("vk.com", "vk.ru", "userapi.com", "vkuser.net", "vk-cdn.net")
MAX_DOMAINS = ("max.ru", "oneme.ru", "okcdn.ru", "mycdn.me", "vkuser.net", "userapi.com")

def allowed(url, domains):
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        return parts.scheme == "https" and not parts.username and not parts.password and parts.port in (None, 443) and any(
            host == root or host.endswith("." + root) for root in domains)
    except ValueError:
        return False

async def read_document(url, name, domains):
    if not allowed(url, domains):
        return None
    try:
        async with ClientSession(timeout=ClientTimeout(total=18)) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200 or (response.content_length or 0) > MAX_SIZE:
                    return None
                data = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    if len(data) + len(chunk) > MAX_SIZE:
                        return None
                    data.extend(chunk)
                if data:
                    return {"name": str(name or "Файл")[:160], "bytes": base64.b64encode(data).decode()}
    except (ClientError, TimeoutError):
        return None
