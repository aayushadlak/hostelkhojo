from .database import engine, Base
from sqlalchemy import text

def seed_database() -> None:
    """
    Verify database schema and run automatic migrations for SQLite.
    """
    Base.metadata.create_all(bind=engine)
    
    # Automatic schema migration check for SQLite
    if engine.name == "sqlite":
        try:
            with engine.connect() as conn:
                # check hostels table
                res = conn.execute(text("PRAGMA table_info(hostels)"))
                cols = [row[1] for row in res.fetchall()]
                if "owner_id" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN owner_id VARCHAR"))
                
                # check property_submissions table
                res = conn.execute(text("PRAGMA table_info(property_submissions)"))
                cols = [row[1] for row in res.fetchall()]
                if "owner_id" not in cols:
                    conn.execute(text("ALTER TABLE property_submissions ADD COLUMN owner_id VARCHAR"))

                # check users table
                res = conn.execute(text("PRAGMA table_info(users)"))
                cols = [row[1] for row in res.fetchall()]
                if "role" not in cols:
                    conn.execute(text("ALTER TABLE users ADD COLUMN role VARCHAR DEFAULT 'student'"))
                
                conn.commit()
        except Exception as mig_err:
            print(f"Migration notice: {mig_err}")

    # Seed default Admin account if none exists
    try:
        from .database import SessionLocal
        from .models import UserDB, HostelDB
        from .auth import get_password_hash
        import uuid
        import json

        db = SessionLocal()
        existing_admin = db.query(UserDB).filter(UserDB.role == "admin").first()
        if not existing_admin:
            admin_user = UserDB(
                id=f"usr_admin_{uuid.uuid4().hex[:6]}",
                email="admin@hostelkhojo.in",
                phone="9999999999",
                password_hash=get_password_hash("adminpassword123"),
                full_name="Hostel Khojo Admin",
                role="admin"
            )
            db.add(admin_user)
            db.commit()
            print("Default Super Admin account seeded: admin@hostelkhojo.in / 9999999999")

        # Seed initial hostels if table is empty
        if db.query(HostelDB).count() == 0:
            sample_hostels = [
                HostelDB(
                    id="h_1",
                    name="St. Xavier's Luxury Student Residency",
                    university="Delhi University North Campus",
                    city="Delhi",
                    gender="Co-ed",
                    type="Verified Luxury PG & Co-Living",
                    rent=12500.0,
                    deposit=10000.0,
                    distance=0.3,
                    rating=4.9,
                    reviews_count=42,
                    verified=True,
                    featured=True,
                    image_main="assets/images/exterior1.png",
                    image_single="assets/images/room_single.png",
                    image_shared="assets/images/room_shared.png",
                    image_mess="assets/images/mess.png",
                    address="Hudson Lane, Vijay Nagar, DU North Campus, New Delhi",
                    map_coords_json=json.dumps({"top": 35, "left": 48}),
                    amenities_json=json.dumps(["Wi-Fi", "4-Time Mess", "AC", "Laundry", "24x7 Power Backup", "Biometric Entry"]),
                    curfew="11:00 PM",
                    room_sharing_json=json.dumps(["Single", "Double", "Triple"]),
                    description="Premium verified student living space with high-speed Wi-Fi, biometric security, air conditioning, and nutritious 4-time meals daily.",
                    mess_menu_json=json.dumps({"breakfast": "Aloo Paratha / Poha & Chai", "lunch": "Paneer, Dal Tadka, Roti, Rice, Salad", "snacks": "Samosa / Tea", "dinner": "Special Thali & Sweet Dish"})
                ),
                HostelDB(
                    id="h_2",
                    name="Kota Scholars Girls Residency",
                    university="Allen & Resonance Institute Area",
                    city="Kota",
                    gender="Girls",
                    type="Verified Girls PG & Hostel",
                    rent=9500.0,
                    deposit=8000.0,
                    distance=0.2,
                    rating=4.8,
                    reviews_count=28,
                    verified=True,
                    featured=True,
                    image_main="assets/images/exterior1.png",
                    image_single="assets/images/room_single.png",
                    image_shared="assets/images/room_shared.png",
                    image_mess="assets/images/mess.png",
                    address="Rajeev Gandhi Nagar, Landmark City, Kota, Rajasthan",
                    map_coords_json=json.dumps({"top": 55, "left": 62}),
                    amenities_json=json.dumps(["Wi-Fi", "4-Time Mess", "AC", "CCTV Security", "Study Lounge", "24x7 Power Backup"]),
                    curfew="10:00 PM",
                    room_sharing_json=json.dumps(["Single", "Double"]),
                    description="Safe, quiet, and academic-friendly residency for female students. Includes 24/7 security guard, study tables, and quiet ambiance.",
                    mess_menu_json=json.dumps({"breakfast": "Idli Sambhar / Upma & Milk", "lunch": "Rajma Chawal, Chapati, Curd", "snacks": "Tea & Biscuits", "dinner": "Mixed Veg, Dal, Roti, Kheer"})
                )
            ]
            db.add_all(sample_hostels)
            db.commit()
            print("Initial sample hostels seeded into database.")

        db.close()
    except Exception as admin_err:
        print(f"Seeding notice: {admin_err}")

    print("Database schema verified and ready.")

if __name__ == "__main__":
    seed_database()
