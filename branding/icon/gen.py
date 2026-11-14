import math
def squircle(cx=512, cy=512, r=412, n=5.0, steps=180):
    pts=[]
    for i in range(steps):
        t=2*math.pi*i/steps
        c,s=math.cos(t),math.sin(t)
        x=cx+r*math.copysign(abs(c)**(2/n),c)
        y=cy+r*math.copysign(abs(s)**(2/n),s)
        pts.append(f"{x:.1f},{y:.1f}")
    return "M"+" L".join(pts)+"Z"
SQ=squircle()

def tile(gid, top, bottom, rim_top=".28", rim_bottom=".0"):
    # the plate: vertical light, a lit top rim, no cast shadow
    return f'''<linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>
<linearGradient id="{gid}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="{rim_top}"/><stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient>''', \
    f'<path d="{SQ}" fill="url(#{gid})"/><path d="{SQ}" fill="none" stroke="url(#{gid}r)" stroke-width="6"/>'

defs=[]; sym={}


# ---------- 1 · Kristály: a trillion-cut gem (the "A"), facets lit from the top ----------
d,plate=tile("p1","#191c3f","#07081a")
A,L,R=(512,226),(236,760),(788,760)
C=(512,575)
def lerp(p,q,t): return (p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t)
P=lambda *ps:"M"+" L".join(f"{x:.1f},{y:.1f}" for x,y in ps)+"Z"
tA,tL,tR=lerp(A,C,.5),lerp(L,C,.5),lerp(R,C,.5)          # the table
mAL,mAR,mLR=lerp(A,L,.5),lerp(A,R,.5),lerp(L,R,.5)        # edge midpoints
defs.append(d+"""
<radialGradient id="k_bloom" cx="512" cy="600" r="360" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7d7aff" stop-opacity=".45"/><stop offset=".6" stop-color="#4b48d0" stop-opacity=".1"/><stop offset="1" stop-color="#4b48d0" stop-opacity="0"/></radialGradient>
<radialGradient id="k_table" cx="512" cy="520" r="190" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#d9d7ff"/><stop offset="1" stop-color="#9d99ff"/></radialGradient>
<linearGradient id="k_star" x1="0" y1="380" x2="0" y2="680" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset="1" stop-color="#fff" stop-opacity=".55"/></linearGradient>""")
# facet tones by how much each faces the light above: upper facets bright, lower facets deep
tone={"up":"#eeedff","upmid":"#c3c0ff","side":"#9591fa","low":"#5f5ae0","deep":"#322d9c"}
facets=[(P(A,mAL,tA),"up"),(P(A,mAR,tA),"up"),                       # beside the apex
        (P(mAL,tA,tL),"upmid"),(P(mAR,tA,tR),"upmid"),
        (P(mAL,L,tL),"side"),(P(mAR,R,tR),"side"),
        (P(L,mLR,tL),"low"),(P(R,mLR,tR),"low"),
        (P(mLR,tL,tR),"deep")]
gem=f'<circle cx="512" cy="600" r="360" fill="url(#k_bloom)"/>'
gem+="".join(f'<path d="{p}" fill="{tone[t]}"/>' for p,t in facets)
gem+=f'<path d="{P(tA,tL,tR)}" fill="url(#k_table)"/>'
# the table's inner star: the facets of the pavilion seen through the table
sA,sL,sR=lerp(tA,C,.62),lerp(tL,C,.62),lerp(tR,C,.62)
gem+=f'<path d="M{tA[0]:.1f},{tA[1]:.1f} L{sL[0]:.1f},{sL[1]:.1f} L{tR[0]:.1f},{tR[1]:.1f} L{sA[0]:.1f},{sA[1]:.1f} L{tL[0]:.1f},{tL[1]:.1f} L{sR[0]:.1f},{sR[1]:.1f}Z" fill="url(#k_star)"/>'
lines=[(A,tA),(L,tL),(R,tR),(mAL,tA),(mAL,tL),(mAR,tA),(mAR,tR),(mLR,tL),(mLR,tR)]
gem+='<g stroke="#fff" stroke-linecap="round" fill="none">'+"".join(f'<path d="M{a[0]:.1f},{a[1]:.1f} L{b[0]:.1f},{b[1]:.1f}" stroke-width="2.6" opacity=".55"/>' for a,b in lines)
gem+=f'<path d="{P(tA,tL,tR)}" stroke-width="3.4" opacity=".9"/><path d="{P(A,L,R)}" stroke-width="6" stroke-linejoin="round" opacity=".95"/></g>'
gem+=f'<path d="M{A[0]},{A[1]} L{mAL[0]:.1f},{mAL[1]:.1f}" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".5"/><path d="M{A[0]},{A[1]} L{mAR[0]:.1f},{mAR[1]:.1f}" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".5"/>'
sym["k"]=plate+gem
sym["k_s"]=plate+(f'<path d="{P((512,236),(250,770),(774,770))}" fill="#a7a3ff"/>'
  f'<path d="{P((512,236),(381,503),(512,503))}" fill="#efeeff"/><path d="{P((512,236),(643,503),(512,503))}" fill="#efeeff"/>'
  f'<path d="{P((381,503),(250,770),(512,770),(512,503))}" fill="#7c77f2"/><path d="{P((643,503),(774,770),(512,770),(512,503))}" fill="#5f5ae0"/>'
  f'<path d="{P((512,236),(250,770),(774,770))}" fill="none" stroke="#fff" stroke-width="20" stroke-linejoin="round"/>')

# ---------- 2 · Hangvilla: machined steel tuning fork, the agents in tune ----------
d,plate=tile("p2","#2e3140","#0f1015",".22")
defs.append(d+"""
<linearGradient id="f_tine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4a505c"/><stop offset=".18" stop-color="#9aa2b0"/><stop offset=".36" stop-color="#ffffff"/><stop offset=".5" stop-color="#e3e7ee"/><stop offset=".78" stop-color="#8a92a0"/><stop offset="1" stop-color="#3d424c"/></linearGradient>
<linearGradient id="f_u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f6"/><stop offset=".6" stop-color="#9ba3b1"/><stop offset="1" stop-color="#4a505c"/></linearGradient>
<radialGradient id="f_ball" cx=".5" cy=".28" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#b9c0cc"/><stop offset="1" stop-color="#363b44"/></radialGradient>
<linearGradient id="f_wave" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a9a6ff"/><stop offset="1" stop-color="#6b67f0"/></linearGradient>""")
def arcs(side):
    out=""
    for i,(r,op,w) in enumerate([(70,.9,12),(118,.55,10),(166,.3,8)]):
        cx = 330 if side<0 else 694
        a0,a1 = (150,210) if side<0 else (-30,30)
        import math
        x0,y0 = cx+r*math.cos(math.radians(a0)), 360+r*math.sin(math.radians(a0))
        x1,y1 = cx+r*math.cos(math.radians(a1)), 360+r*math.sin(math.radians(a1))
        sweep = 0 if side<0 else 1
        out+=f'<path d="M{x0:.1f},{y0:.1f} A{r},{r} 0 0 {sweep} {x1:.1f},{y1:.1f}" stroke="url(#f_wave)" stroke-width="{w}" stroke-linecap="round" fill="none" opacity="{op}"/>'
    return out
# the waves start beside the tines, mirrored
def arcs2(side):
    import math
    out=""; cx = 512
    for r,op,w in [(190,.9,12),(240,.55,10),(290,.3,8)]:
        a0,a1 = ((160,200) if side<0 else (-20,20))
        x0,y0=cx+r*math.cos(math.radians(a0)),360+r*math.sin(math.radians(a0))
        x1,y1=cx+r*math.cos(math.radians(a1)),360+r*math.sin(math.radians(a1))
        out+=f'<path d="M{x0:.1f},{y0:.1f} A{r},{r} 0 0 {0 if side<0 else 1} {x1:.1f},{y1:.1f}" stroke="url(#f_wave)" stroke-width="{w}" stroke-linecap="round" fill="none" opacity="{op}"/>'
    return out
fork=(arcs2(-1)+arcs2(1)+
  '<rect x="396" y="214" width="78" height="360" rx="39" fill="url(#f_tine)"/>'
  '<rect x="550" y="214" width="78" height="360" rx="39" fill="url(#f_tine)"/>'
  '<path d="M396 520 L396 566 A116 116 0 0 0 628 566 L628 520 L550 520 L550 566 A38 38 0 0 1 474 566 L474 520 Z" fill="url(#f_u)"/>'
  '<path d="M486 676 L538 676 L532 776 L492 776 Z" fill="url(#f_tine)"/>'
  '<circle cx="512" cy="800" r="40" fill="url(#f_ball)"/>'
  '<g stroke="#fff" stroke-linecap="round" opacity=".95"><path d="M414 236 L456 236" stroke-width="5"/><path d="M568 236 L610 236" stroke-width="5"/></g>'
  '<g stroke="#000" stroke-opacity=".35" stroke-width="3" fill="none"><path d="M474 520 L474 566 A38 38 0 0 0 550 566 L550 520"/></g>')
sym["f"]=plate+fork
sym["f_s"]=plate+('<rect x="372" y="214" width="100" height="360" rx="50" fill="url(#f_tine)"/><rect x="552" y="214" width="100" height="360" rx="50" fill="url(#f_tine)"/>'
  '<path d="M372 520 L372 566 A140 140 0 0 0 652 566 L652 520 L552 520 L552 566 A40 40 0 0 1 472 566 L472 520 Z" fill="url(#f_u)"/><rect x="474" y="690" width="76" height="140" rx="22" fill="url(#f_tine)"/>')

# ---------- 3 · Együttes: three crystal beads set in a machined gold ring (a room) ----------
d,plate=tile("p3","#11264a","#050d1d",".24")
defs.append(d+"""
<linearGradient id="r_gold" x1="0" y1="190" x2="0" y2="834" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff6dd"/><stop offset=".18" stop-color="#f1c76a"/><stop offset=".5" stop-color="#a87726"/><stop offset=".78" stop-color="#e6bd62"/><stop offset="1" stop-color="#5f400f"/></linearGradient>
<radialGradient id="r_inner" cx="512" cy="470" r="280" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#24497c"/><stop offset="1" stop-color="#081528"/></radialGradient>
<radialGradient id="b_c" cx=".5" cy=".32" r=".78"><stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#e2ebff"/><stop offset=".72" stop-color="#7d9bd6"/><stop offset="1" stop-color="#2a4478"/></radialGradient>
<radialGradient id="b_core" cx=".5" cy=".7" r=".5"><stop offset="0" stop-color="#bfe0ff" stop-opacity=".9"/><stop offset="1" stop-color="#bfe0ff" stop-opacity="0"/></radialGradient>""")
import math
def bead(cx,cy,r=84):
    return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="url(#b_c)"/>'
            f'<circle cx="{cx:.1f}" cy="{cy+r*.28:.1f}" r="{r*.62:.1f}" fill="url(#b_core)"/>'
            f'<ellipse cx="{cx:.1f}" cy="{cy-r*.5:.1f}" rx="{r*.46:.1f}" ry="{r*.2:.1f}" fill="#fff" opacity=".85"/>'
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r-1.5}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="3"/>')
ticks="".join(f'<path d="M{512+300*math.cos(math.radians(a)):.1f},{512+300*math.sin(math.radians(a)):.1f} L{512+(300-(16 if a%30==0 else 9))*math.cos(math.radians(a)):.1f},{512+(300-(16 if a%30==0 else 9))*math.sin(math.radians(a)):.1f}" />' for a in range(-90,270,10))
ring=('<circle cx="512" cy="512" r="300" fill="url(#r_inner)"/>'
  f'<g stroke="#e9c878" stroke-opacity=".55" stroke-width="3" stroke-linecap="round">{ticks}</g>'
  '<circle cx="512" cy="512" r="324" fill="none" stroke="url(#r_gold)" stroke-width="46"/>'
  '<circle cx="512" cy="512" r="346" fill="none" stroke="#fff7e0" stroke-opacity=".6" stroke-width="3"/>'
  '<circle cx="512" cy="512" r="301" fill="none" stroke="#2c1e05" stroke-opacity=".7" stroke-width="3"/>'
  '<g stroke="#e9c878" stroke-opacity=".35" stroke-width="3" fill="none"><path d="M512 400 L420 560 L604 560 Z"/></g>')
pos=[(512,392),(408,572),(616,572)]
sym["r"]=plate+ring+"".join(bead(x,y) for x,y in pos)
sym["r_s"]=plate+('<circle cx="512" cy="512" r="300" fill="url(#r_inner)" stroke="url(#r_gold)" stroke-width="80"/>'+"".join(bead(x,y,108) for x,y in [(512,372),(390,584),(634,584)]))

# ---------- 4 · Bárka: porcelain arch (the Ark, the stage), the stage lit inside ----------
d,plate=tile("p4","#f3f4f8","#d3d8e2",".9")
defs.append(d+"""
<linearGradient id="a_por" x1="0" y1="250" x2="0" y2="800" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eef0f5"/><stop offset="1" stop-color="#bfc6d3"/></linearGradient>
<linearGradient id="a_stage" x1="0" y1="380" x2="0" y2="800" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1c1a52"/><stop offset=".6" stop-color="#3b37b0"/><stop offset="1" stop-color="#8d89ff"/></linearGradient>
<radialGradient id="a_spot" cx="512" cy="800" r="200" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".5" stop-color="#c8c6ff" stop-opacity=".35"/><stop offset="1" stop-color="#c8c6ff" stop-opacity="0"/></radialGradient>
<linearGradient id="a_key" x1="0" y1="214" x2="0" y2="384" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f2f1ff"/><stop offset=".45" stop-color="#8d89ff"/><stop offset="1" stop-color="#2f2aa0"/></linearGradient>""")
arch=('<path d="M384 800 L384 530 A128 128 0 0 1 640 530 L640 800 Z" fill="url(#a_stage)"/>'
  '<path d="M384 800 L384 530 A128 128 0 0 1 640 530 L640 800 Z" fill="url(#a_spot)"/>'
  '<path d="M236 800 L236 530 A276 276 0 0 1 788 530 L788 800 L640 800 L640 530 A128 128 0 0 0 384 530 L384 800 Z" fill="url(#a_por)"/>'
  '<path d="M384 800 L384 530 A128 128 0 0 1 640 530 L640 800" fill="none" stroke="#9aa3b5" stroke-width="8"/>'
  '<path d="M250 530 A262 262 0 0 1 774 530" fill="none" stroke="#fff" stroke-width="7"/>'
  '<path d="M454 214 L570 214 L550 384 L474 384 Z" fill="url(#a_key)"/>'
  '<path d="M454 214 L570 214 L560 290 L464 290 Z" fill="#fff" opacity=".3"/>'
  '<path d="M454 214 L570 214" stroke="#fff" stroke-width="6" stroke-linecap="round"/>'
  '<path d="M236 800 L788 800" stroke="#a3abba" stroke-width="5"/>')
sym["a"]=plate+arch
sym["a_s"]=plate+('<path d="M384 810 L384 530 A128 128 0 0 1 640 530 L640 810 Z" fill="url(#a_stage)"/>'
  '<path d="M224 810 L224 530 A288 288 0 0 1 800 530 L800 810 L640 810 L640 530 A128 128 0 0 0 384 530 L384 810 Z" fill="url(#a_por)" stroke="#9aa3b5" stroke-width="16"/>'
  '<path d="M444 200 L580 200 L556 396 L468 396 Z" fill="url(#a_key)"/>')

open("defs.svg","w").write('<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'+"".join(defs)+
  "".join(f'<symbol id="i_{k}" viewBox="0 0 1024 1024">{v}</symbol>' for k,v in sym.items())+'</defs></svg>')

# standalone files of the chosen direction (Kristály)
open("k.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>{defs[0]}</defs>{sym["k"]}</svg>')
open("k_s.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>{defs[0]}</defs>{sym["k_s"]}</svg>')
