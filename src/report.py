"""สร้างรายงานยอดขายรายเดือนเป็น Markdown

ใช้งาน: python -m src.report 2026-03
ผลลัพธ์อยู่ที่ reports/monthly_report.md ตัวเลขทุกตัวคำนวณผ่านฟังก์ชันใน metrics.py
"""
import sys
from pathlib import Path

import pandas as pd

from src import metrics as m

REPORTS = Path(__file__).resolve().parent.parent / "reports"


def _baht(x: float) -> str:
    return f"{x:,.0f} บาท"


def build_report(df: pd.DataFrame, month: str) -> str:
    """คืนเนื้อหารายงาน Markdown ของเดือน month ('YYYY-MM')"""
    monthly = m.monthly_sales(df)
    if month not in monthly.index:
        raise ValueError(f"ไม่มีข้อมูลยอดขายของเดือน {month}")

    current = monthly[month]
    pos = list(monthly.index).index(month)
    if pos > 0:
        prev_month = monthly.index[pos - 1]
        prev = monthly[prev_month]
        change = (current - prev) / prev * 100
        compare = f"{prev_month}: {_baht(prev)} ({change:+.1f}%)"
    else:
        compare = "ไม่มีข้อมูลเดือนก่อนหน้า"

    month_df = df[df["month"] == month]
    lines = [
        f"# รายงานยอดขายประจำเดือน {month} · บ้านสบาย ช็อป",
        "",
        "| ตัวชี้วัด | ค่า |",
        "|---|---|",
        f"| ยอดขายสุทธิ | {_baht(current)} |",
        f"| เทียบเดือนก่อน | {compare} |",
        f"| อัตรายกเลิก | {m.cancel_rate(month_df):.2f}% |",
        f"| อัตราคืนสินค้า | {m.return_rate(month_df):.2f}% |",
        "",
        "## 5 สินค้าขายดี (ตามยอดขายสุทธิ)",
        "",
        "| อันดับ | รหัส | สินค้า | จำนวน | ยอดขายสุทธิ |",
        "|---|---|---|---:|---:|",
    ]
    for i, row in m.top_products(month_df, 5).iterrows():
        lines.append(
            f"| {i + 1} | {row.product_id} | {row.product_name} | {row.qty:,} | {_baht(row.net)} |"
        )
    return "\n".join(lines) + "\n"


def write_report(month: str, out_path: Path | str = REPORTS / "monthly_report.md",
                 df: pd.DataFrame | None = None) -> Path:
    """เขียนรายงานลงไฟล์ แล้วคืน path ของไฟล์"""
    if df is None:
        df = m.load_orders()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(build_report(df, month), encoding="utf-8")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("ใช้งาน: python -m src.report YYYY-MM")
    print(f"เขียนรายงานแล้ว: {write_report(sys.argv[1])}")
