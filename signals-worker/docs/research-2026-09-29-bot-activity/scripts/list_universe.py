"""List every symbol Binance's public archive (data.binance.vision) holds for
spot and USDS-M futures monthly 1h klines, including delisted ones."""
import json, re, sys, urllib.request, xml.etree.ElementTree as ET
S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
def prefixes(prefix):
    out, marker = [], ""
    while True:
        url = f"{S3}?delimiter=/&prefix={prefix}" + (f"&marker={marker}" if marker else "")
        root = ET.fromstring(urllib.request.urlopen(url, timeout=60).read())
        ps = [p.find("s3:Prefix", NS).text for p in root.findall("s3:CommonPrefixes", NS)]
        out += ps
        trunc = root.find("s3:IsTruncated", NS).text == "true"
        if not trunc or not ps: break
        marker = ps[-1]
    return [p[len(prefix):].strip("/") for p in out]
spot = prefixes("data/spot/monthly/klines/")
um = prefixes("data/futures/um/monthly/klines/")
json.dump({"spot": spot, "um": um}, open("universe.json", "w"))
print(len(spot), "spot symbols;", len(um), "um symbols")
print("um USDT:", sum(1 for s in um if s.endswith("USDT")), " sample:", [s for s in um if s.startswith("1000")][:12])
