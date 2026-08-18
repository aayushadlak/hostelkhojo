from .database import engine, Base
from sqlalchemy import text

def seed_database() -> None:
    """
    Verify database schema and run automatic migrations for SQLite.
    """
    Base.metadata.create_all(bind=engine)
    
    # Automatic schema migration check for SQLite and PostgreSQL
    try:
        with engine.connect() as conn:
            if engine.name == "sqlite":
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
            else:
                # PostgreSQL migrations for Render cloud database
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS owner_id VARCHAR;"))
                conn.execute(text("ALTER TABLE property_submissions ADD COLUMN IF NOT EXISTS owner_id VARCHAR;"))
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR DEFAULT 'student';"))
                conn.commit()
    except Exception as mig_err:
        print(f"Migration notice: {mig_err}")

    # Seed default Admin account, PG Owners, and Student accounts if DB is fresh
    try:
        from .database import SessionLocal
        from .models import UserDB, HostelDB, BookingDB, RoommateDB
        from .auth import get_password_hash
        import uuid
        import json

        db = SessionLocal()

        # Seed Users
        existing_users_count = db.query(UserDB).count()
        if existing_users_count < 11:
            seed_users = [
                UserDB(id="usr_admin_master", email="admin@hostelkhojo.in", phone="9999999999", password_hash=get_password_hash("adminpassword123"), full_name="Hostel Khojo Admin", role="admin"),
                UserDB(id="usr_owner_1", email="rajesh.sharma@greenstay.in", phone="9876543210", password_hash=get_password_hash("owner123"), full_name="Rajesh Sharma (Green Stay PG)", role="owner"),
                UserDB(id="usr_owner_2", email="sunita.v@comforthostels.com", phone="9812345678", password_hash=get_password_hash("owner123"), full_name="Sunita Verma (Comfort Luxury Hostel)", role="owner"),
                UserDB(id="usr_owner_3", email="vikram@malhotraproperties.in", phone="9711223344", password_hash=get_password_hash("owner123"), full_name="Vikram Malhotra (Malhotra PG for Boys)", role="owner"),
                UserDB(id="usr_owner_4", email="anita.d@saraswatihostel.in", phone="9654321098", password_hash=get_password_hash("owner123"), full_name="Anita Deshmukh (Saraswati Girls Hostel)", role="owner"),
                UserDB(id="usr_student_1", email="aarav.k@iitd.ac.in", phone="9123456789", password_hash=get_password_hash("student123"), full_name="Aarav Kumar", role="student"),
                UserDB(id="usr_student_2", email="ananya.roy@gmail.com", phone="9234567890", password_hash=get_password_hash("student123"), full_name="Ananya Roy", role="student"),
                UserDB(id="usr_student_3", email="rohan.g@du.ac.in", phone="9345678901", password_hash=get_password_hash("student123"), full_name="Rohan Gupta", role="student"),
                UserDB(id="usr_student_4", email="priya.p@nift.ac.in", phone="9456789012", password_hash=get_password_hash("student123"), full_name="Priya Patel", role="student"),
                UserDB(id="usr_student_5", email="kabir.singh@gmail.com", phone="9567890123", password_hash=get_password_hash("student123"), full_name="Kabir Singh", role="student"),
                UserDB(id="usr_student_6", email="sneha.reddy@hyderabad.edu", phone="9678901234", password_hash=get_password_hash("student123"), full_name="Sneha Reddy", role="student")
            ]

            for u in seed_users:
                existing = db.query(UserDB).filter(
                    (UserDB.id == u.id) | (UserDB.email == u.email) | (UserDB.phone == u.phone)
                ).first()
                if not existing:
                    try:
                        db.add(u)
                        db.commit()
                    except Exception:
                        db.rollback()
            print("Successfully verified/seeded platform accounts (4 Owners, 6 Students, 1 Admin)")

        # Seed Hostels
        existing_hostels = db.query(HostelDB).count()
        if existing_hostels < 3:
            seed_hostels = [
                HostelDB(
                    id="h_greenstay_01",
                    name="Green Stay Luxury PG & Hostel",
                    type="pg",
                    gender="male",
                    city="Delhi",
                    university="DU North Campus",
                    address="Hudson Lane, GTB Nagar, Delhi",
                    rent=9500,
                    rating=4.8,
                    owner_id="usr_owner_1",
                    owner_name="Rajesh Sharma",
                    contact_phone="9876543210",
                    contact_email="rajesh.sharma@greenstay.in",
                    image="https://images.unsplash.com/photo-1555854877-bab0e564b8d5?auto=format&fit=crop&w=500&q=80",
                    amenities=json.dumps(["AC", "Wi-Fi", "Food/Mess", "Power Backup", "CCTV"]),
                    room_sharing=json.dumps(["single", "double"])
                ),
                HostelDB(
                    id="h_comforthostel_02",
                    name="Comfort Luxury Girls Hostel",
                    type="hostel",
                    gender="female",
                    city="Bengaluru",
                    university="Christ University",
                    address="Koramangala 5th Block, Bengaluru",
                    rent=12000,
                    rating=4.9,
                    owner_id="usr_owner_2",
                    owner_name="Sunita Verma",
                    contact_phone="9812345678",
                    contact_email="sunita.v@comforthostels.com",
                    image="https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?auto=format&fit=crop&w=500&q=80",
                    amenities=json.dumps(["AC", "Wi-Fi", "Attached Washroom", "Laundry", "24x7 Security"]),
                    room_sharing=json.dumps(["single", "double"])
                ),
                HostelDB(
                    id="h_malhotra_03",
                    name="Malhotra PG for Boys",
                    type="pg",
                    gender="male",
                    city="Kota",
                    university="Kota Coaching Hub",
                    address="Rajeev Gandhi Nagar, Kota",
                    rent=8000,
                    rating=4.6,
                    owner_id="usr_owner_3",
                    owner_name="Vikram Malhotra",
                    contact_phone="9711223344",
                    contact_email="vikram@malhotraproperties.in",
                    image="https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=500&q=80",
                    amenities=json.dumps(["Wi-Fi", "Food/Mess", "Study Table", "Biometric Entry"]),
                    room_sharing=json.dumps(["double", "triple"])
                )
            ]
            for h in seed_hostels:
                ex = db.query(HostelDB).filter(HostelDB.id == h.id).first()
                if not ex:
                    db.add(h)
            db.commit()
            print("Successfully seeded 3 live hostels & PGs")

        # Seed Bookings
        existing_bookings = db.query(BookingDB).count()
        if existing_bookings == 0:
            seed_bookings = [
                BookingDB(
                    id="b_seed_01",
                    hostel_id="h_greenstay_01",
                    hostel_name="Green Stay Luxury PG & Hostel",
                    user_name="Aarav Kumar",
                    user_phone="9123456789",
                    visit_date="2026-08-25",
                    visit_time="11:00 AM",
                    status="pending"
                ),
                BookingDB(
                    id="b_seed_02",
                    hostel_id="h_greenstay_01",
                    hostel_name="Green Stay Luxury PG & Hostel",
                    user_name="Ananya Roy",
                    user_phone="9234567890",
                    visit_date="2026-08-26",
                    visit_time="03:00 PM",
                    status="confirmed"
                )
            ]
            for b in seed_bookings:
                db.add(b)
            db.commit()

        db.close()
    except Exception as admin_err:
        print(f"Seeding notice: {admin_err}")

    print("Database schema verified and ready.")


if __name__ == "__main__":
    seed_database()
