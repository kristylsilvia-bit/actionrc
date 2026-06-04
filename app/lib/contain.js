import { useEffect, useState } from 'react';

// Given a container ref and the video's aspect ratio (w/h), returns the
// pixel rect that an object-fit:contain image actually occupies inside it.
// Used to position privacy-zone overlays exactly over the visible frame.
export function useContainRect(ref, aspect) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function compute() {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch || !aspect) {
        setRect(null);
        return;
      }
      const containerAspect = cw / ch;
      let w;
      let h;
      if (containerAspect > aspect) {
        h = ch;
        w = ch * aspect;
      } else {
        w = cw;
        h = cw / aspect;
      }
      setRect({ left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h });
    }

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);

  return rect;
}
