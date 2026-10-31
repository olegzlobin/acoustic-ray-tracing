"""Exact (BTM) attenuation re free field of a thin rigid half-plane at the BRAS RS5 positions, no floor.
Writes core/testdata/rs5_halfplane_btm.json. Run from the repo root: python3 tools/diffraction/rs5_table.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from btm import C, XE, ZE, btm, dist, theta, visible

SRC = {1: (2.487, 1.235), 2: (2.487, 2.0), 3: (2.487, 3.0), 4: (2.487, 0.135)}
MIC = {1: (8.512, 1.235), 2: (8.512, 0.006), 3: (8.512, 2.0), 4: (8.512, 3.0)}
FC = [125, 250, 500, 1000, 2000, 4000]
E = (XE, ZE)
rows = []
for a, s in SRC.items():
    for b, l in MIC.items():
        vis = visible(s, l)
        R = dist(s, l)
        rp = R if vis else dist(s, E) + dist(E, l)
        db = []
        for fc in FC:
            f = np.geomspace(fc / np.sqrt(2), fc * np.sqrt(2), 24)
            k = 2 * np.pi * f / C
            p = btm(s, l, k) + (np.exp(-1j * k * R) / R if vis else 0)
            db.append(round(float(10 * np.log10(np.mean(np.abs(p) ** 2)) + 20 * np.log10(rp)), 3))
        rows.append(dict(ls=a, mp=b, src=s, lis=l, visible=bool(vis), path_len=rp, total_db_re_free_field=db))
out = dict(source="BTM line integral, thin rigid half-plane, edge along y at x=5.487 z=2.066, c=343.0, band = mean |p|^2 over 24 log-spaced freqs per octave, level re 1/path_len (path_len = direct if visible else over the edge)", rows=rows)
json.dump(out, open("core/testdata/rs5_halfplane_btm.json", "w"), indent=1)
