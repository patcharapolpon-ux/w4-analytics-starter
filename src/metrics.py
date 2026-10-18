"""ฟังก์ชันคำนวณตัวชี้วัดของบ้านสบาย ช็อป

ทุกฟังก์ชันรับ DataFrame ที่ได้จาก load_orders() เป็นพารามิเตอร์แรก
นิยามตัวชี้วัดอยู่ใน CLAUDE.md
"""
from pathlib import Path

import pandas as pd

DATA = Path(__file__).resolve().parent.parent / "data"

DELIVERED = "จัดส่งสำเร็จ"
CANCELLED = "ยกเลิก"
RETURNED = "คืนสินค้า"


def load_orders(path: Path | str = DATA / "orders.csv") -> pd.DataFrame:
    """อ่าน orders.csv แล้วเพิ่มคอลัมน์ที่ใช้บ่อย: net, unit_cost, gp, month, date

    net และ gp คิดทุกแถว (มูลค่าของบรรทัดนั้น) ฟังก์ชันสรุปผลจะกรองเฉพาะจัดส่งสำเร็จเอง
    """
    df = pd.read_csv(path, encoding="utf-8-sig")
    products = pd.read_csv(DATA / "products.csv", encoding="utf-8-sig")
    # map แทน merge เพื่อไม่ให้จำนวนแถวเปลี่ยนแม้ products มี product_id ซ้ำ
    cost = products.drop_duplicates("product_id").set_index("product_id")["unit_cost"]
    df["unit_cost"] = df["product_id"].map(cost)
    df["net"] = df["qty"] * df["unit_price"] * (1 - df["discount_pct"] / 100)
    df["gp"] = df["net"] - df["qty"] * df["unit_cost"]
    df["month"] = df["order_datetime"].str[:7]
    df["date"] = df["order_datetime"].str[:10]
    return df


def _delivered(df: pd.DataFrame) -> pd.DataFrame:
    return df[df["status"] == DELIVERED]


def _status_rate(df: pd.DataFrame, status: str) -> float:
    if len(df) == 0:
        return float("nan")
    return (df["status"] == status).sum() / len(df) * 100


def _between_dates(df: pd.DataFrame, start_date: str | None, end_date: str | None) -> pd.DataFrame:
    # เทียบกับคอลัมน์ date (YYYY-MM-DD) เพื่อให้รวมวันปลายทางทั้งวัน
    if start_date is not None:
        df = df[df["date"] >= start_date]
    if end_date is not None:
        df = df[df["date"] <= end_date]
    return df


def net_sales(df: pd.DataFrame) -> float:
    """ยอดขายสุทธิรวม (บาท)"""
    return float(_delivered(df)["net"].sum())


def gross_profit(df: pd.DataFrame) -> float:
    """กำไรขั้นต้นรวม (บาท)"""
    return float(_delivered(df)["gp"].sum())


def aov(df: pd.DataFrame) -> float:
    """ยอดขายสุทธิเฉลี่ยต่อคำสั่งซื้อที่จัดส่งสำเร็จ (บาท)"""
    d = _delivered(df)
    return float(d["net"].sum() / d["order_id"].nunique())


def cancel_rate(df: pd.DataFrame) -> float:
    """อัตรายกเลิกของคำสั่งซื้อทั้งหมดใน df (เปอร์เซ็นต์ 0–100)"""
    return float(_status_rate(df, CANCELLED))


def monthly_sales(df: pd.DataFrame) -> pd.Series:
    """ยอดขายสุทธิรายเดือน index = 'YYYY-MM' เรียงตามเวลา"""
    return _delivered(df).groupby("month")["net"].sum().sort_index()


def best_month(df: pd.DataFrame) -> str:
    """เดือนที่ยอดขายสุทธิสูงสุด ('YYYY-MM')"""
    return str(monthly_sales(df).idxmax())


def channel_share(df: pd.DataFrame, channel: str, start_month: str, end_month: str) -> float:
    """สัดส่วนยอดขายสุทธิของช่องทางในช่วงเดือน start_month..end_month (รวมทั้งสองเดือน) เป็นเปอร์เซ็นต์"""
    d = _delivered(df)
    d = d[(d["month"] >= start_month) & (d["month"] <= end_month)]
    total = d["net"].sum()
    return float(d.loc[d["channel"] == channel, "net"].sum() / total * 100)


def top_products(df: pd.DataFrame, n: int = 5) -> pd.DataFrame:
    """n สินค้าที่ยอดขายสุทธิสูงสุด คืน DataFrame คอลัมน์ product_id, product_name, qty, net"""
    return (
        _delivered(df)
        .groupby(["product_id", "product_name"], as_index=False)[["qty", "net"]]
        .sum()
        .sort_values("net", ascending=False)
        .head(n)
        .reset_index(drop=True)
    )


def rating_by_ship_bucket(df: pd.DataFrame) -> dict[str, float]:
    """คะแนนรีวิวเฉลี่ยตามระยะส่ง คืน dict คีย์ '1-2', '3-4', '5-6', '7+'"""
    d = df.dropna(subset=["rating", "ship_days"])
    labels = ["1-2", "3-4", "5-6", "7+"]
    bucket = pd.cut(d["ship_days"], bins=[0, 2, 4, 6, float("inf")], labels=labels)
    means = d.groupby(bucket, observed=False)["rating"].mean()
    return {label: float(means[label]) for label in labels}


def top_province(df: pd.DataFrame, region: str) -> str:
    """จังหวัดที่มียอดขายสุทธิสูงสุดในภูมิภาคที่ระบุ"""
    d = _delivered(df)
    return str(d[d["region"] == region].groupby("province")["net"].sum().idxmax())


def avg_ship_days(df: pd.DataFrame, region: str | None = None, carrier: str | None = None,
                  start_date: str | None = None, end_date: str | None = None) -> float:
    """ระยะส่งเฉลี่ย (วัน) ตามตัวกรองที่ให้มา วันที่เป็น 'YYYY-MM-DD' และรวมทั้งสองวัน"""
    d = _between_dates(df, start_date, end_date)
    if region is not None:
        d = d[d["region"] == region]
    if carrier is not None:
        d = d[d["carrier"] == carrier]
    return float(d["ship_days"].dropna().mean())


def return_rate(df: pd.DataFrame, product_id: str | None = None,
                start_date: str | None = None, end_date: str | None = None) -> float:
    """อัตราคืนสินค้า (เปอร์เซ็นต์) ของสินค้าและช่วงวันที่ที่ระบุ"""
    d = _between_dates(df, start_date, end_date)
    if product_id is not None:
        d = d[d["product_id"] == product_id]
    return float(_status_rate(d, RETURNED))
