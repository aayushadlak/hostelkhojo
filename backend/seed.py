from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, UserDB

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Purge dummy sample hostels, dummy roommates, and demo user accounts
        dummy_hostel_ids = ["h_1", "h_2", "h_3"]
        dummy_roommate_ids = ["rm_1", "rm_2"]

        db.query(HostelDB).filter(HostelDB.id.in_(dummy_hostel_ids)).delete(synchronize_session=False)
        db.query(RoommateDB).filter(RoommateDB.id.in_(dummy_roommate_ids)).delete(synchronize_session=False)
        db.query(UserDB).filter((UserDB.id == "usr_demo_1") | (UserDB.email == "student@hostelkhojo.in")).delete(synchronize_session=False)

        db.commit()
        print("Database initialized cleanly: Purged all dummy hostels, roommates, and demo accounts.")
    except Exception as e:
        db.rollback()
        print(f"Database cleanup status: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
