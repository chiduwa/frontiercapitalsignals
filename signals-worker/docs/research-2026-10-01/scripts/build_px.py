import numpy as np, os
ARCH = "/private/tmp/claude-501/-Users-owner/b677f588-0ff8-4f26-8c37-a5e343026c67/scratchpad/exh/data"
def close_at(E):
    out = np.full(len(E), np.nan); cache = {}
    for k, (c, t) in enumerate(zip(E.coin, E.t)):
        if c not in cache:
            d = np.load(os.path.join(ARCH, c + ".npz")); m = dict(zip(d["s_t"].tolist(), d["s"][:, 3]))
            if os.path.exists(f"sep/{c}.npz"):
                e = np.load(f"sep/{c}.npz"); m.update(zip(e["t"].tolist(), e["s"][:, 3]))
            cache[c] = m
        out[k] = cache[c].get(int(t), np.nan)
    return out
