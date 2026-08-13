from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, UserDB, ReviewDB

def seed_database():
    Base.metadata.create_all(bind=engine)
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
