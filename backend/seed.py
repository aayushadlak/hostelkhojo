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
        from .models import UserDB
        from .auth import get_password_hash
        import uuid

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
        db.close()
    except Exception as admin_err:
        print(f"Admin seeding notice: {admin_err}")

    print("Database schema verified and ready.")

if __name__ == "__main__":
    seed_database()
