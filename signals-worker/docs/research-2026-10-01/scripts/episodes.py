import numpy as np, pandas as pd
from stats import row, show, table, ct
E = pd.read_pickle("events_x.pkl").sort_values(["coin","t"]).reset_index(drop=True)
H = 3_600_000
# episode = a coin's prints with gaps <= 72h; how far price already ran past the FIRST alert
E["ep"] = (E.groupby("coin").t.diff().fillna(1e18) > 72*H).groupby(E.coin).cumsum()
E["entry"] = E.fwd24*0  # placeholder
import glob
first_px = {}
# price at print reconstructed from peak/fwd isn't stored; reload close from npz grid via build's loader
import build_px
E["px"] = build_px.close_at(E)
g = E.groupby(["coin","ep"])
E["k_in_ep"] = g.cumcount()
E["vs_first"] = E.px / g.px.transform("first") - 1
E["ep_len"] = g.t.transform("size")
E.to_pickle("events_ep.pkl")

m = E[E.coin=="MOVR"].copy(); m["at"]=pd.to_datetime(m.t,unit="ms")
print("## MOVR every print"); print(m[["at","case","tier","run24Z","streak72","vol24_x","turn_proxy","px","fwd24","exc24","exc72","peak24"]].round(3).to_string(index=False))
s = E.exc24.dropna()
for v in (0.539, 0.633): print(f"exc24 >= {v:.0%}: {(s>=v).mean()*100:.2f}% of all prints ({(s>=v).sum()})")
show("price already vs the episode's FIRST alert (later prints only)", table("vs_first",[-np.inf,0,0.15,0.3,0.6,1,np.inf], data=E[E.k_in_ep>0]))
show("position in episode", table("k_in_ep",[0,1,2,4,8,16,np.inf],["1st","2nd","3-4th","5-8th","9-16th","17th+"], data=E))
