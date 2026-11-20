Size it against the scale on {{SIZING_SCALE}}; where that scale differs from the table below, the
repository's scale wins. Points measure complexity, effort, uncertainty, and dependencies
together, not hours alone:

| Points | Meaning |
|---|---|
| 1 | 15 to 60 minutes; a tiny change, a config tweak, one line |
| 2 | 1 to 2 hours; a small isolated task with little risk |
| 3 | 2 to 4 hours; a small feature or a straightforward fix |
| 5 | half a day to a day, with some unknowns |
| 8 | 1 to 2 days; moderate feature or integration work |
| 13 | 2 to 3 days spanning several components |
| 21 | 3 to 5 days, near the point where it should be split |

Size the work the issue actually requires, not the work you would like it to be. An issue whose fix
is one line but which needs a rendered before-and-after across four surfaces is not a 1. Count the
proof the change will owe as part of its size.

