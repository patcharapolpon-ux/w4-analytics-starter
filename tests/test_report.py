"""test ของรายงานรายเดือน (W4-B)"""
import pytest

from src import metrics as m
from src import report


@pytest.fixture(scope="module")
def df():
    return m.load_orders()


def test_report_march_net_sales(df):
    assert "| ยอดขายสุทธิ | 1,147,155 บาท |" in report.build_report(df, "2026-03")


def test_report_has_all_sections(df):
    text = report.build_report(df, "2026-03")
    for heading in ["เทียบเดือนก่อน", "2026-02", "5 สินค้าขายดี", "อัตรายกเลิก", "อัตราคืนสินค้า"]:
        assert heading in text
    # ตาราง 5 สินค้าขายดีต้องมีครบ 5 แถว
    assert sum(line.startswith(f"| {i} |") for line in text.splitlines() for i in range(1, 6)) == 5


def test_report_first_month_has_no_previous(df):
    assert "ไม่มีข้อมูลเดือนก่อนหน้า" in report.build_report(df, "2025-10")


def test_write_report_creates_file(df, tmp_path):
    out = report.write_report("2026-03", tmp_path / "monthly_report.md", df=df)
    assert out.exists()
    assert "1,147,155 บาท" in out.read_text(encoding="utf-8")
