from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, UserDB, ReviewDB
from sqlalchemy import text

def seed_database():
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

    db = SessionLocal()
    try:
        # Purge ALL hostels, roommates, reviews, and demo users from database
        db.query(HostelDB).delete(synchronize_session=False)
        db.query(RoommateDB).delete(synchronize_session=False)
        db.query(ReviewDB).delete(synchronize_session=False)
        db.query(UserDB).filter((UserDB.id == "usr_demo_1") | (UserDB.email == "student@hostelkhojo.in")).delete(synchronize_session=False)

        db.commit()
        print("Database initialized cleanly: Purged ALL hostels, roommates, reviews, and demo accounts.")
    except Exception as e:
        db.rollback()
        print(f"Database cleanup status: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()

