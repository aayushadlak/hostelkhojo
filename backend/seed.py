try:
    from .database import engine, Base
except ImportError:
    from database import engine, Base
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
                if "is_live" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN is_live BOOLEAN DEFAULT 1"))
                if "occupancy_pricing_json" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN occupancy_pricing_json TEXT DEFAULT '{}'"))
                if "registration_fee" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN registration_fee FLOAT DEFAULT 0.0"))
                if "image_washroom" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN image_washroom VARCHAR"))
                if "map_link" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN map_link VARCHAR DEFAULT ''"))
                if "lat" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN lat FLOAT DEFAULT 28.6922"))
                if "lng" not in cols:
                    conn.execute(text("ALTER TABLE hostels ADD COLUMN lng FLOAT DEFAULT 77.2100"))
                
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
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS is_live BOOLEAN DEFAULT TRUE;"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS occupancy_pricing_json TEXT DEFAULT '{}';"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS registration_fee FLOAT DEFAULT 0.0;"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS image_washroom VARCHAR;"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS map_link VARCHAR DEFAULT '';"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS lat FLOAT DEFAULT 28.6922;"))
                conn.execute(text("ALTER TABLE hostels ADD COLUMN IF NOT EXISTS lng FLOAT DEFAULT 77.2100;"))
                conn.execute(text("ALTER TABLE property_submissions ADD COLUMN IF NOT EXISTS owner_id VARCHAR;"))
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR DEFAULT 'student';"))
                conn.commit()

    except Exception as mig_err:
        print(f"Migration notice: {mig_err}")

    try:
        try:
            from .database import SessionLocal
            from .models import UserDB
            from .auth import get_password_hash
        except ImportError:
            from database import SessionLocal
            from models import UserDB
            from auth import get_password_hash

        db = SessionLocal()

        existing_admin = db.query(UserDB).filter(UserDB.role == "admin").first()
        if not existing_admin:
            admin_user = UserDB(
                id="usr_admin_master",
                email="admin@hostelkhojo.in",
                phone="9999999999",
                password_hash=get_password_hash("adminpassword123"),
                full_name="Hostel Khojo Admin",
                role="admin"
            )
            db.add(admin_user)
            db.commit()
            print("Default Super Admin account initialized: admin@hostelkhojo.in / 9999999999")

        db.close()
    except Exception as admin_err:
        print(f"Seeding notice: {admin_err}")

    print("Database schema verified and ready.")


if __name__ == "__main__":
    seed_database()
