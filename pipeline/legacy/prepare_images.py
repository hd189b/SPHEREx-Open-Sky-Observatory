"""Reproject two real SPHEREx FITS files to a common north-up grid.
Run from a directory containing obs0.json, obs1.json and pair0.fits/pair1.fits
(or full0.fits/full1.fits). Requirements: astropy, reproject, numpy, pillow.
"""
import json
from pathlib import Path
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.time import Time
from reproject import reproject_interp
from PIL import Image
obs=[json.load(open(f'obs{i}.json')) for i in range(2)]
center=np.mean([[float(o['comet_ra']),float(o['comet_dec'])] for o in obs],axis=0)
out=Path(__file__).parent/'dist';n=512;fov=.45
w=WCS(naxis=2);w.wcs.crpix=[(n+1)/2,(n+1)/2];w.wcs.crval=center;w.wcs.cdelt=[-fov/n,fov/n];w.wcs.ctype=['RA---TAN','DEC--TAN']
arrays=[]
for i in range(2):
 p=Path(f'science{i}.fits')
 if not p.exists() or p.stat().st_size<2880:p=Path(f'full{i}.fits')
 h=fits.open(p);print(i,[(x.name,None if x.data is None else x.data.shape) for x in h])
 sci=next((x for x in h if x.name=='IMAGE'),None)
 if sci is None:sci=next(x for x in h if x.data is not None and x.data.ndim==2 and x.data.dtype.kind=='f')
 arr,foot=reproject_interp((sci.data,WCS(sci.header).celestial),w,shape_out=(n,n));arr[foot<.9]=np.nan
 arrays.append(arr);print('finite',np.isfinite(arr).mean(),'range',np.nanpercentile(arr,[1,50,99,99.8]))
values=np.concatenate([a[np.isfinite(a)] for a in arrays]);lo,hi=np.percentile(values,[8,99.7])
for i,a in enumerate(arrays):
 z=np.arcsinh(np.clip((a-lo)/(hi-lo),0,1)*8)/np.arcsinh(8);v=np.nan_to_num(z,nan=0)
 rgb=np.stack([v*.88,v*.95,v],axis=-1);Image.fromarray(np.uint8(np.flipud(rgb)*255)).save(out/f'epoch-{i}.png')
 px,py=w.world_to_pixel_values(float(obs[i]['comet_ra']),float(obs[i]['comet_dec']));utc=Time(float(obs[i]['t_min']),format='mjd').isot+'Z';obs[i].update(image=f'epoch-{i}.png',id=obs[i]['obs_creator_did'],utc=utc,label=utc[:10]+' · '+utc[11:16],marker=[float(px)/n,1-float(py)/n],source=obs[i]['access_url'])
meta=dict(center=center.tolist(),fov=fov,processing=f'SPHEREx QR2 · detector D3 (1.63–2.43 μm detector coverage, not one uniform filter). Bilinear WCS reprojection to a shared {n} × {n} ICRS grid. Shared asinh display stretch, lower={lo:.6g}, upper={hi:.6g}; blue-tinted grayscale. Black indicates no coverage. Predicted positions from IRSA’s 3I/ATLAS observation table.',observations=obs)
json.dump(meta,open(out/'observations.json','w'),indent=2)
