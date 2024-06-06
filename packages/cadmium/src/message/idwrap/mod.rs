use std::cell::RefCell;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::workbench::Workbench;
use crate::IDType;

mod de;
mod ser;

use super::{Identifiable, MessageHandler, ProjectMessageHandler};

#[derive(Tsify, Debug, Clone)]
#[tsify(from_wasm_abi)]
pub struct IDWrap<T: Clone + Serialize + for<'de> Deserialize<'de> + wasm_bindgen::convert::RefFromWasmAbi> {
    pub id: u64,
    pub inner: T,
}

impl<T: Clone + Serialize + for<'de> Deserialize<'de> + wasm_bindgen::convert::RefFromWasmAbi> IDWrap<T> {
    pub fn new(id: IDType, h: T) -> Self {
        Self {
            id,
            inner: h,
        }
    }

    pub fn id(&self) -> IDType {
        self.id
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }
}

// First level message handler
impl<'a, T> ProjectMessageHandler for IDWrap<T>
where
    T: MessageHandler<Parent = Rc<RefCell<Workbench>>> + Clone + Serialize + for<'de> Deserialize<'de> + wasm_bindgen::convert::RefFromWasmAbi,
    crate::message::message::Message: From<Self>
{
    fn handle_project_message(&self, project: &mut crate::project::Project) -> anyhow::Result<Option<IDType>> {
        let wb = T::Parent::from_parent_id(project, self.id)?;
        let result = self.inner.handle_message(wb.clone())?;

        wb.borrow_mut().add_message_step(&self.clone().into());

        Ok(result)
    }
}

// Second level message handler
impl<T, C, P> MessageHandler for IDWrap<T>
where
    T: MessageHandler<Parent = C> + Clone + Serialize + for<'de> Deserialize<'de> + wasm_bindgen::convert::RefFromWasmAbi,
    C: Identifiable<Parent = P>,
    P: Identifiable,
{
    type Parent = C::Parent;
    fn handle_message(&self, parent: Self::Parent) -> anyhow::Result<Option<IDType>> {
        let prnt = C::from_parent_id(&parent, self.id)?;
        self.inner.handle_message(prnt)
    }
}