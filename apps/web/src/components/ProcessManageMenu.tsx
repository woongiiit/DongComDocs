import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export default function ProcessManageMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={rootRef} className="admin-dropdown">
      <button
        type="button"
        className="btn secondary"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        프로세스 관리
      </button>
      {open ? (
        <ul className="admin-dropdown__menu" role="menu">
          <li role="none">
            <Link role="menuitem" className="admin-dropdown__link" to="/admin/processes/create" onClick={() => setOpen(false)}>
              프로세스 생성
            </Link>
          </li>
          <li role="none">
            <Link role="menuitem" className="admin-dropdown__link" to="/admin/processes/manage" onClick={() => setOpen(false)}>
              프로세스 관리
            </Link>
          </li>
          <li role="none">
            <Link role="menuitem" className="admin-dropdown__link" to="/admin/processes/edit" onClick={() => setOpen(false)}>
              프로세스 수정
            </Link>
          </li>
          <li role="none">
            <Link
              role="menuitem"
              className="admin-dropdown__link"
              to="/admin/processes/layout-analysis"
              onClick={() => setOpen(false)}
            >
              레이아웃 분석
            </Link>
          </li>
          <li role="none">
            <Link
              role="menuitem"
              className="admin-dropdown__link"
              to="/admin/processes/document-processing"
              onClick={() => setOpen(false)}
            >
              문서 처리 실행
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
